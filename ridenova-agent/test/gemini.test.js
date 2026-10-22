// Gemini adapter tests against a FAKE Gemini server (no network, no key). They prove request/response translation,
// verbatim replay of Gemini parts (thought signatures), retries and error mapping. They do NOT prove that Google's
// real API accepts these requests - run `npm run check-llm` with your real key for that.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient, createLlmClient, toGeminiContents, toGeminiTools, fromGeminiResponse, LlmError } from '../server/llm.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { DemoRepo } from '../server/demo.js';
import { TODAY, d } from './helpers.js';
import { TOOL_DEFS } from '../server/tools.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const err = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
function fakeGemini(handlers) { const reqs = []; const f = async (url, opts) => { reqs.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return handlers.shift()(reqs.at(-1)); }; f.reqs = reqs; return f; }

test('provider selection from env', () => {
  assert.equal(loadConfig({ GEMINI_API_KEY: 'g' }).llm.provider, 'gemini');
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'a' }).llm.provider, 'anthropic');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).llm.provider, 'anthropic', 'both set: Anthropic unless LLM_PROVIDER says otherwise');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', LLM_PROVIDER: 'gemini' }).llm.provider, 'gemini');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'g' }).llm.model, 'gemini-3.8-flash');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-2.5-flash' }).llm.model, 'gemini-2.5-flash');
  assert.equal(createLlmClient({ provider: 'gemini', apiKey: '', model: 'm' }).configured, false);
});

test('tool declarations: every real agent tool converts; empty-parameter tools omit `parameters`', () => {
  const t = toGeminiTools(TOOL_DEFS)[0].functionDeclarations;
  assert.equal(t.length, TOOL_DEFS.length);
  assert.equal('parameters' in t.find((x) => x.name === 'get_my_bookings'), false);
  const search = t.find((x) => x.name === 'search_vehicles');
  assert.deepEqual(search.parameters.required, ['start_date', 'end_date']);
  assert.ok(search.parameters.properties.vehicle_type.enum.includes('SUV'));
});

test('request: key in header (not URL), systemInstruction, contents, generationConfig', async () => {
  const f = fakeGemini([() => ok({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] })]);
  const llm = createGeminiClient({ apiKey: 'SECRET-KEY', model: 'gemini-3.8-flash' }, f);
  const r = await llm.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }], tools: TOOL_DEFS });
  const q = f.reqs[0];
  assert.equal(q.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.ok(!q.url.includes('SECRET-KEY')); assert.equal(q.headers['x-goog-api-key'], 'SECRET-KEY');
  assert.deepEqual(q.body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(q.body.contents.map((c) => [c.role, c.parts[0].text]), [['user', 'hi'], ['model', 'yo'], ['user', 'again']]);
  assert.ok(q.body.generationConfig.maxOutputTokens >= 2048);
  assert.equal(r.stop_reason, 'end_turn'); assert.equal(r.content[0].text, 'hello');
});

test('function call round trip: ids mapped, thought signature replayed verbatim, thought text hidden', async () => {
  const signedPart = { functionCall: { name: 'search_vehicles', args: { start_date: d(5), end_date: d(7) } }, thoughtSignature: 'SIG-abc123==' };
  const f = fakeGemini([
    () => ok({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking about it', thought: true }, signedPart] }, finishReason: 'STOP' }] }),
    () => ok({ candidates: [{ content: { parts: [{ text: 'Found 3 cars.' }] }, finishReason: 'STOP' }] }),
  ]);
  const llm = createGeminiClient({ apiKey: 'k', model: 'm' }, f);
  const messages = [{ role: 'user', content: 'cars?' }];
  const r1 = await llm.complete({ system: 's', messages, tools: TOOL_DEFS });
  assert.equal(r1.stop_reason, 'tool_use');
  const call = r1.content.find((b) => b.type === 'tool_use');
  assert.equal(call.name, 'search_vehicles'); assert.deepEqual(call.input, signedPart.functionCall.args);
  assert.ok(!r1.content.some((b) => b.type === 'text'), 'thought summaries must not surface as answer text');
  messages.push({ role: 'assistant', content: r1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ ok: true, matches: 3 }) }] });
  const r2 = await llm.complete({ system: 's', messages, tools: TOOL_DEFS });
  assert.equal(r2.content[0].text, 'Found 3 cars.');
  const sent = f.reqs[1].body.contents;
  assert.deepEqual(sent[1], { role: 'model', parts: [{ text: 'thinking about it', thought: true }, signedPart] }, 'model turn replayed exactly as received');
  assert.deepEqual(sent[2], { role: 'user', parts: [{ functionResponse: { name: 'search_vehicles', response: { ok: true, matches: 3 } } }] });
});

test('when Gemini supplies function-call ids they are echoed in functionResponse', () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { id: 'call-9', name: 'get_my_bookings', args: {} } }] }, finishReason: 'STOP' }] });
  const call = r.content.find((b) => b.type === 'tool_use'); assert.equal(call.id, 'call-9');
  const contents = toGeminiContents([{ role: 'user', content: 'x' }, { role: 'assistant', content: r.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-9', content: 'not json' }] }]);
  assert.deepEqual(contents[2].parts[0].functionResponse, { id: 'call-9', name: 'get_my_bookings', response: { result: 'not json' } });
});

test('history built without gemini_raw (e.g. string turns after a UI confirm) still converts', () => {
  const contents = toGeminiContents([{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'get_my_bookings', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{"ok":true}' }] }, { role: 'assistant', content: 'done' }]);
  assert.deepEqual(contents[1], { role: 'model', parts: [{ functionCall: { name: 'get_my_bookings', args: {} } }] });
  assert.deepEqual(contents[3], { role: 'model', parts: [{ text: 'done' }] });
});

test('retries once on 429/503, then maps errors to clear messages', async () => {
  const good = () => ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  let f = fakeGemini([() => err(429, 'quota'), good]);
  assert.equal((await createGeminiClient({ apiKey: 'k', model: 'm' }, f, { retryDelayMs: 1 }).complete({ messages: [{ role: 'user', content: 'x' }] })).content[0].text, 'ok');
  const run = (status, msg) => createGeminiClient({ apiKey: 'k', model: 'my-model' }, fakeGemini(Array(3).fill(() => err(status, msg))), { retryDelayMs: 1 }).complete({ messages: [{ role: 'user', content: 'x' }] });
  await assert.rejects(() => run(429, 'quota'), (e) => e instanceof LlmError && e.status === 429 && /free-tier limit/.test(e.message));
  await assert.rejects(() => run(404, 'not found'), (e) => /GEMINI_MODEL/.test(e.message) && /my-model/.test(e.message));
  await assert.rejects(() => run(400, 'API key not valid. Please pass a valid API key.'), (e) => /GEMINI_API_KEY/.test(e.message));
  await assert.rejects(() => run(403, 'denied'), (e) => /refused/.test(e.message));
  await assert.rejects(() => createGeminiClient({ apiKey: '', model: 'm' }, f).complete({ messages: [] }), (e) => e.status === 503);
});

test('503 "high demand": 3 attempts, then a friendly busy message (status 429 so the UI says try again)', async () => {
  const f = fakeGemini([() => err(503, 'This model is currently experiencing high demand.'), () => err(503, 'again'), () => err(503, 'again')]);
  await assert.rejects(() => createGeminiClient({ apiKey: 'k', model: 'm' }, f, { retryDelayMs: 1 }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (e) => e.status === 429 && /busy right now/.test(e.message) && /not a problem with the app/.test(e.message));
  assert.equal(f.reqs.length, 3);
  const f2 = fakeGemini([() => err(503, 'busy'), () => err(503, 'busy'), () => ok({ candidates: [{ content: { parts: [{ text: 'worked on 3rd try' }] } }] })]);
  assert.equal((await createGeminiClient({ apiKey: 'k', model: 'm' }, f2, { retryDelayMs: 1 }).complete({ messages: [{ role: 'user', content: 'x' }] })).content[0].text, 'worked on 3rd try');
});

test('blocked prompts and empty candidates give clear errors', () => {
  assert.throws(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked/);
  assert.throws(() => fromGeminiResponse({}), /no answer/);
  assert.throws(() => fromGeminiResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), /declined/);
});

// ---- whole stack: browser-style HTTP -> agent -> Gemini adapter (fake Gemini) -> tools -> demo repo
const servers = []; after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));
test('end-to-end through the Gemini adapter: search, propose, confirm gate still enforced', async () => {
  const sig = 'SIG-e2e';
  const f = fakeGemini([
    () => ok({ candidates: [{ content: { parts: [{ functionCall: { name: 'search_vehicles', args: { start_date: d(20), end_date: d(22), vehicle_type: 'SUV' } }, thoughtSignature: sig }] } }] }),
    () => ok({ candidates: [{ content: { parts: [{ text: 'Here are the SUVs.' }] } }] }),
    () => ok({ candidates: [{ content: { parts: [{ functionCall: { name: 'propose_booking', args: { vehicle_id: 'a00DEMO00000000005', pickup_date: d(20), return_date: d(22), pickup_location: 'Airport', drop_location: 'Airport' } }, thoughtSignature: 'SIG-2' }] } }] }),
    () => ok({ candidates: [{ content: { parts: [{ text: 'Please press Confirm.' }] } }] }),
  ]);
  const config = loadConfig({ MODE: 'demo', GEMINI_API_KEY: 'k', ADMIN_TOKEN: 't' });
  const repo = new DemoRepo(TODAY);
  const { server } = createApp({ config, repo, llm: createGeminiClient(config.llm, f) });
  servers.push(server); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const SID = 'gemini-session-123456';
  assert.equal((await (await fetch(base + '/api/status')).json()).provider, 'gemini');
  await post('/api/identify', { sessionId: SID, email: 'aarav@example.com' });
  const s = await post('/api/chat', { sessionId: SID, message: 'SUVs on the 20th for 2 days' });
  assert.equal(s.status, 200); assert.equal(s.body.cards[0].type, 'vehicles'); assert.equal(s.body.reply, 'Here are the SUVs.');
  const secondReq = f.reqs[1].body.contents;
  assert.equal(secondReq[1].parts[0].thoughtSignature, sig, 'signature survives the agent loop');
  assert.equal(secondReq[2].parts[0].functionResponse.name, 'search_vehicles');
  const n = repo.bookings.length;
  const p = await post('/api/chat', { sessionId: SID, message: 'book the Nexon' });
  assert.equal(p.body.pending.type, 'booking'); assert.equal(repo.bookings.length, n, 'Gemini cannot write without the Confirm button');
  assert.equal((await post('/api/confirm', { sessionId: SID, actionId: p.body.pending.id })).status, 200);
  assert.equal(repo.bookings.length, n + 1);
});
