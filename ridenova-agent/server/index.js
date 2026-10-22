import { loadConfig, loadEnvFile } from './config.js';
loadEnvFile();
if (process.argv.includes('--demo')) process.env.MODE = 'demo'; // cross-platform alternative to `MODE=demo node ...` (does not work on Windows)
import { createApp } from './app.js';
import { createLlmClient } from './llm.js';
import { SalesforceClient, SalesforceRepo } from './salesforce.js';
import { DemoRepo } from './demo.js';
import { todayIn } from './util.js';

const config = loadConfig();
const llm = createLlmClient(config.llm);
let repo; let sfStatus = { ok: true };

if (config.mode === 'demo') {
  repo = new DemoRepo(todayIn(config.tz));
  console.log('MODE: DEMO - using built-in sample data. Nothing here comes from Salesforce.');
} else {
  repo = new SalesforceRepo(new SalesforceClient(config.sf), config.sf);
  try { await repo.sf.authenticate(); await repo.health(); console.log('MODE: SALESFORCE - connected.'); }
  catch (e) { sfStatus = { ok: false, error: e.message }; console.error(`MODE: SALESFORCE - connection FAILED: ${e.message}\n  Fix credentials in .env, or run with MODE=demo for labelled sample data.`); }
}
if (!llm.configured) console.warn('WARNING: no AI key set (GEMINI_API_KEY or ANTHROPIC_API_KEY) - the chat agent and AI summary are disabled.');
else console.log(`AI: ${llm.provider} / ${llm.model}`);
if (llm.configured && llm.provider === 'gemini' && config.mode === 'salesforce') console.warn('NOTE: Gemini FREE-tier prompts may be used by Google to improve its products. Use test/sample records only, not real customer data.');

const { server } = createApp({ config, repo, llm, sfStatus });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`RideNova AI running at http://localhost:${config.port}`);
  console.log(`Admin token${config.adminTokenGenerated ? ' (generated for this run)' : ''}: ${config.adminToken}`);
});
