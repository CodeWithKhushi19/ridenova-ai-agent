import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function pickLlm(e) {
  const requested = e('LLM_PROVIDER').toLowerCase();
  const provider = requested === 'gemini' || requested === 'anthropic' ? requested : (e('GEMINI_API_KEY') && !e('ANTHROPIC_API_KEY') ? 'gemini' : 'anthropic');
  return provider === 'gemini'
    ? { provider, apiKey: e('GEMINI_API_KEY'), model: e('GEMINI_MODEL', 'gemini-3.8-flash') }
    : { provider, apiKey: e('ANTHROPIC_API_KEY'), model: e('ANTHROPIC_MODEL', 'claude-sonnet-5-5') };
}

export function loadConfig(env = process.env) {
  const e = (k, d = '') => (env[k] ?? d).toString().trim();
  const hasToken = !!(e('SF_INSTANCE_URL') && e('SF_ACCESS_TOKEN'));
  const hasClientCreds = !!(e('SF_LOGIN_URL') && e('SF_CLIENT_ID') && e('SF_CLIENT_SECRET'));
  const requested = e('MODE').toLowerCase();
  const mode = requested === 'demo' ? 'demo' : requested === 'salesforce' ? 'salesforce' : (hasToken || hasClientCreds ? 'salesforce' : 'demo');
  const adminToken = e('ADMIN_TOKEN') || crypto.randomBytes(9).toString('base64url');
  return {
    root: ROOT,
    port: Number(e('PORT', '3000')) || 3000,
    tz: e('APP_TIMEZONE', 'Asia/Kolkata'),
    mode,
    sf: { instanceUrl: e('SF_INSTANCE_URL').replace(/\/+$/, ''), accessToken: e('SF_ACCESS_TOKEN'),
      loginUrl: e('SF_LOGIN_URL').replace(/\/+$/, ''), clientId: e('SF_CLIENT_ID'), clientSecret: e('SF_CLIENT_SECRET'),
      ticketDescriptionField: e('TICKET_DESCRIPTION_FIELD') },
    llm: pickLlm(e),
    adminToken,
    adminTokenGenerated: !e('ADMIN_TOKEN'),
  };
}
export function loadEnvFile() { loadDotEnv(path.join(ROOT, '.env')); }
