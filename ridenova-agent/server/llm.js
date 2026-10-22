// LLM clients. The agent speaks one internal format (Anthropic-style content blocks:
// text / tool_use / tool_result). Each provider adapter translates to and from it.
export class LlmError extends Error { constructor(m, status) { super(m); this.status = status; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLlmClient(llmCfg, fetchImpl = fetch) {
  return llmCfg.provider === 'gemini' ? createGeminiClient(llmCfg, fetchImpl) : createAnthropicClient(llmCfg, fetchImpl);
}

// ------------------------------------------------------------------ Anthropic
export function createAnthropicClient({ apiKey, model }, fetchImpl = fetch) {
  return {
    provider: 'anthropic', configured: !!apiKey, model,
    async complete({ system, messages, tools, maxTokens = 1024 }) {
      if (!apiKey) throw new LlmError('ANTHROPIC_API_KEY is not configured', 503);
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools?.length ? { tools } : {}) }),
        signal: AbortSignal.timeout(60000),
      }).catch((e) => { throw new LlmError(`Could not reach the AI service (${e.cause?.code || e.cause?.message || e.name}) - check your internet connection, VPN or firewall`, 502); });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new LlmError(body?.error?.message || `AI service error ${res.status}`, res.status === 429 ? 429 : 502);
      return body;
    },
  };
}

// ------------------------------------------------------------------ Gemini (generateContent REST)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini's function declarations take an OpenAPI-style schema; our tool schemas are already in that subset.
 *  An object with NO properties is rejected by the API, so such tools are declared without parameters. */
export function toGeminiTools(tools = []) {
  if (!tools.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => {
    const hasProps = t.input_schema?.properties && Object.keys(t.input_schema.properties).length > 0;
    return { name: t.name, description: t.description, ...(hasProps ? { parameters: t.input_schema } : {}) };
  }) }];
}

/** Internal (Anthropic-style) history -> Gemini `contents`. */
export function toGeminiContents(messages) {
  const idToCall = new Map(); // tool_use id -> { name, geminiId }
  const contents = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); continue; }
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') idToCall.set(b.id, { name: b.name, geminiId: b._geminiId });
      const raw = m.content.find((b) => b.type === 'gemini_raw');
      // Replay Gemini's own parts verbatim (this preserves thought signatures, whatever they are called).
      const parts = raw ? raw.parts : m.content.filter((b) => b.type === 'text' || b.type === 'tool_use')
        .map((b) => (b.type === 'text' ? { text: b.text } : { functionCall: { name: b.name, args: b.input ?? {} } }));
      contents.push({ role: 'model', parts });
    } else {
      const parts = m.content.filter((b) => b.type === 'tool_result').map((b) => {
        const call = idToCall.get(b.tool_use_id) || { name: 'unknown_tool' };
        let payload; try { payload = JSON.parse(b.content); } catch { payload = { result: String(b.content) }; }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = { result: payload };
        return { functionResponse: { ...(call.geminiId ? { id: call.geminiId } : {}), name: call.name, response: payload } };
      });
      contents.push({ role: 'user', parts });
    }
  }
  return contents;
}

/** Gemini response -> internal blocks + stop_reason. */
export function fromGeminiResponse(body) {
  if (body?.promptFeedback?.blockReason) throw new LlmError(`The AI service blocked this request (${body.promptFeedback.blockReason}). Try rephrasing.`, 502);
  const cand = body?.candidates?.[0];
  if (!cand) throw new LlmError('The AI service returned no answer. Please try again.', 502);
  const parts = cand.content?.parts ?? [];
  const content = []; let n = 0;
  for (const p of parts) {
    if (p.functionCall) {
      const gid = p.functionCall.id;
      content.push({ type: 'tool_use', id: gid || `gem_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, _geminiId: gid });
    } else if (typeof p.text === 'string' && !p.thought) content.push({ type: 'text', text: p.text });
  }
  if (parts.length) content.push({ type: 'gemini_raw', parts }); // keep original parts for faithful replay
  if (!content.some((b) => b.type !== 'gemini_raw') && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(cand.finishReason)) {
    throw new LlmError(`The AI service declined to answer (${cand.finishReason}). Try rephrasing.`, 502);
  }
  return { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, finish_reason: cand.finishReason };
}

export function createGeminiClient({ apiKey, model }, fetchImpl = fetch, { retryDelayMs = 2000 } = {}) {
  return {
    provider: 'gemini', configured: !!apiKey, model,
    async complete({ system, messages, tools, maxTokens = 1024 }) {
      if (!apiKey) throw new LlmError('GEMINI_API_KEY is not configured', 503);
      const payload = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: toGeminiContents(messages),
        ...(tools?.length ? { tools: toGeminiTools(tools) } : {}),
        generationConfig: { maxOutputTokens: Math.max(maxTokens * 2, 2048), temperature: 0.2 }, // output budget also covers model "thinking"
      };
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, // key in a header, never in the URL
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000),
        }).catch((e) => { throw new LlmError(`Could not reach the AI service (${e.cause?.code || e.cause?.message || e.name}) - check your internet connection, VPN or firewall`, 502); });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return fromGeminiResponse(body);
        if ((res.status === 429 || res.status === 503) && attempt < 2) { await sleep(retryDelayMs * (attempt + 1)); continue; } // busy/rate-limited: up to 3 tries with growing pauses
        const msg = body?.error?.message || `AI service error ${res.status}`;
        if (res.status === 404) throw new LlmError(`Gemini model "${model}" was not found for your key. Set GEMINI_MODEL in .env to another model (see README). Details: ${msg}`, 502);
        if (res.status === 400 && /API key/i.test(msg)) throw new LlmError('Gemini rejected the API key. Check GEMINI_API_KEY in .env.', 502);
        if (res.status === 401 || res.status === 403) throw new LlmError(`Gemini refused the request (${res.status}). Check the key and that the Gemini API is enabled for its project. ${msg}`, 502);
        if (res.status === 503) throw new LlmError("Google's Gemini servers are busy right now (high demand). This is temporary and not a problem with the app - wait a minute and send your message again.", 429);
        throw new LlmError(res.status === 429 ? 'The AI service is busy or the free-tier limit was reached. Wait a minute and try again.' : msg, res.status === 429 ? 429 : 502);
      }
    },
  };
}
