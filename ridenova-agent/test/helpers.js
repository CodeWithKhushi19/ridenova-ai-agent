import { DemoRepo } from '../server/demo.js';
import { createToolbox } from '../server/tools.js';
import { todayIn, addDays } from '../server/util.js';

export const TODAY = todayIn('Asia/Kolkata');
export const d = (n) => addDays(TODAY, n);
export function makeToolbox() {
  const repo = new DemoRepo(TODAY);
  const toolbox = createToolbox({ repo, today: () => TODAY });
  return { repo, toolbox };
}
export const session = (customerId) => ({ id: 'test-session-1', customer: customerId ? { id: customerId, name: 'Test' } : null, history: [], pending: null });
export const AARAV = '003DEMO00000000001', PRIYA = '003DEMO00000000002';
export const V = (n) => `a00DEMO000000000${String(n).padStart(2, '0')}`;

/** A scripted stand-in for the LLM: returns pre-written tool_use / text responses in order.
 *  Used ONLY in tests to exercise the real agent loop, tools and HTTP layer without network access. */
export function scriptedLlm(script) {
  const calls = [];
  return {
    configured: true, model: 'scripted-test-llm', calls,
    async complete(req) {
      calls.push(structuredClone(req)); // snapshot: the agent keeps mutating its history array
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      const out = typeof next === 'function' ? next(req) : next;
      return out;
    },
  };
}
export const use = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
export const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
