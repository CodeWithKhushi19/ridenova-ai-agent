// One-command smoke test of your real AI key: node scripts/check-llm.js  (or: npm run check-llm)
// Makes 2 tiny requests: (1) model must call a tool, (2) we return a tool result and it must answer using it.
// This exercises exactly what the agent needs: tool calling + multi-turn replay. It never touches Salesforce.
import { loadConfig, loadEnvFile } from '../server/config.js';
import { createLlmClient } from '../server/llm.js';

loadEnvFile();
const cfg = loadConfig();
const llm = createLlmClient(cfg.llm);
const bad = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };
if (!llm.configured) bad(`No API key found for provider "${cfg.llm.provider}". Put GEMINI_API_KEY (or ANTHROPIC_API_KEY) in .env`);
console.log(`Provider: ${llm.provider}   Model: ${llm.model}`);

const tools = [{ name: 'get_secret_number', description: 'Returns the secret number. Always call this when asked for the secret number.', input_schema: { type: 'object', properties: {}, } },
  { name: 'add', description: 'Adds two integers.', input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }];
const system = 'You are a test assistant. Use the tools when needed. Never guess tool results.';
const messages = [{ role: 'user', content: 'What is the secret number? Use the tool.' }];
try {
  const r1 = await llm.complete({ system, messages, tools });
  const call = r1.content.find((b) => b.type === 'tool_use');
  if (!call) bad(`Model did not call a tool. It said: ${JSON.stringify(r1.content.filter((b) => b.type === 'text').map((b) => b.text))}`);
  console.log(`1) tool call OK -> ${call.name}(${JSON.stringify(call.input)})`);
  messages.push({ role: 'assistant', content: r1.content });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ ok: true, secret: 4242 }) }] });
  const r2 = await llm.complete({ system, messages, tools });
  const text = r2.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  if (!/4242/.test(text)) bad(`Model's answer did not contain the tool result 4242. Answer: ${text || '(empty)'}`);
  console.log(`2) tool result used OK -> "${text.trim().slice(0, 120)}"`);
  console.log('\nPASS: this key and model can run the RideNova agent.');
} catch (e) { bad(`${e.message}${e.status ? ` (HTTP-ish status ${e.status})` : ''}`); }
