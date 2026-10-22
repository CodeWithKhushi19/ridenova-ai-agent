import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createToolbox } from './tools.js';
import { createAgent, pendingView } from './agent.js';
import { buildInsights, summarizeInsights } from './insights.js';
import { LlmError } from './llm.js';
import { todayIn, isEmail } from './util.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function createApp({ config, repo, llm, sfStatus = { ok: true } }) {
  const today = () => todayIn(config.tz);
  const toolbox = createToolbox({ repo, today });
  const agent = createAgent({ llm, toolbox, today, ticketDescriptionEnabled: !!repo.ticketDescriptionEnabled });
  const sessions = new Map();
  const hits = new Map();
  const publicDir = path.join(config.root, 'public');

  const getSession = (id) => {
    if (!SESSION_ID_RE.test(id || '')) return null;
    let s = sessions.get(id);
    if (!s) {
      if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
      s = { id, customer: null, history: [], pending: null, busy: false, touched: Date.now() };
      sessions.set(id, s);
    }
    s.touched = Date.now();
    return s;
  };
  setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.touched > 2 * 3600e3) sessions.delete(k); }, 600e3).unref();

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const MAX_BODY = 20000, MAX_DRAIN = 1_000_000;
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0, tooBig = false; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_DRAIN) { req.destroy(); return; }          // hard stop for abusive uploads
      if (n > MAX_BODY) { tooBig = true; return; }            // keep draining a little so we can answer 413 cleanly
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(Object.assign(new Error('Request too large'), { code: 413 }));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
  const limited = (req) => {
    const ip = req.socket.remoteAddress; const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000); arr.push(now); hits.set(ip, arr);
    return arr.length > 40;
  };
  const adminOk = (req) => {
    const a = Buffer.from(String(req.headers['x-admin-token'] || '')); const b = Buffer.from(config.adminToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const llmError = (res, e) => {
    const code = e.status === 503 ? 503 : e.status === 429 ? 429 : 502;
    json(res, code, { error: code === 503 ? 'The AI model is not configured on the server (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' : code === 429 ? 'The AI service is busy. Please try again in a moment.' : `The AI service had a problem: ${e.message}` });
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (limited(req)) return json(res, 429, { error: 'Too many requests. Please slow down.' });
        if (req.method === 'GET' && url.pathname === '/api/status') {
          return json(res, 200, { mode: config.mode, dataSource: repo.label, dataSourceOk: sfStatus.ok, dataSourceError: sfStatus.ok ? null : sfStatus.error,
            llmConfigured: !!llm.configured, provider: llm.configured ? llm.provider : null, model: llm.configured ? llm.model : null, today: today() });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/insights') {
          if (!adminOk(req)) return json(res, 401, { error: 'Admin token missing or wrong.' });
          return json(res, 200, { source: repo.label, mode: config.mode, ...(await buildInsights(repo, today())) });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        const body = await readBody(req);
        if (url.pathname === '/api/admin/summary') {
          if (!adminOk(req)) return json(res, 401, { error: 'Admin token missing or wrong.' });
          if (!llm.configured) return json(res, 503, { error: 'AI model not configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' });
          try { return json(res, 200, { summary: await summarizeInsights(llm, await buildInsights(repo, today())) }); } catch (e) { return llmError(res, e instanceof LlmError ? e : new LlmError(e.message, 500)); }
        }
        const s = getSession(body.sessionId);
        if (!s) return json(res, 400, { error: 'Invalid session id' });
        if (url.pathname === '/api/identify') {
          const email = String(body.email || '').trim().toLowerCase();
          if (!isEmail(email)) return json(res, 400, { error: 'Please enter a valid email address.' });
          const found = await repo.findContactsByEmail(email);
          if (found.length === 0) return json(res, 404, { error: 'No customer with that email was found.' });
          if (found.length > 1) return json(res, 409, { error: 'That email matches more than one customer record. Please contact support.' });
          s.customer = found[0]; s.history = []; s.pending = null;
          return json(res, 200, { customer: { name: s.customer.name } });
        }
        if (url.pathname === '/api/reset') { s.history = []; s.pending = null; return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/chat') {
          const msg = String(body.message || '').trim();
          if (!msg) return json(res, 400, { error: 'Please type a message.' });
          if (msg.length > 1000) return json(res, 400, { error: 'Message too long (max 1000 characters).' });
          if (!llm.configured) return json(res, 503, { error: 'The AI model is not configured on the server (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' });
          if (s.busy) return json(res, 409, { error: 'Still working on your previous message.' });
          s.busy = true;
          try { return json(res, 200, await agent.chat(s, msg)); }
          catch (e) { return llmError(res, e instanceof LlmError ? e : new LlmError(e.message, 500)); }
          finally { s.busy = false; }
        }
        if (url.pathname === '/api/confirm' || url.pathname === '/api/reject') {
          const id = String(body.actionId || '');
          if (url.pathname === '/api/reject') {
            const r = toolbox.reject(s, id);
            if (r.ok) s.history.push({ role: 'user', content: '[The customer declined the pending action in the UI.]' }, { role: 'assistant', content: 'No problem - I have not made any changes. Anything else I can help with?' });
            return json(res, 200, { ok: r.ok, message: r.ok ? 'No problem - I have not made any changes.' : 'Nothing to cancel.' });
          }
          const r = await toolbox.confirm(s, id);
          s.history.push({ role: 'user', content: `[The customer pressed Confirm in the UI. System result: ${r.ok ? 'SUCCESS' : 'FAILED'} - ${r.message}]` }, { role: 'assistant', content: r.message });
          return json(res, r.ok ? 200 : 409, r);
        }
        return json(res, 404, { error: 'Not found' });
      }
      // static files
      let rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.normalize(path.join(publicDir, rel));
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (e.code === 413 || e.code === 400) return json(res, e.code, { error: e.message });
      console.error('[server]', e.message);
      json(res, 500, { error: 'Unexpected server error.' });
    }
  });
  return { server, sessions, toolbox };
}
