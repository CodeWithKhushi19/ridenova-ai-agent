const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');
let sid = null;
try { sid = localStorage.getItem('rn_sid'); } catch {}
if (!sid) { sid = crypto.randomUUID(); try { localStorage.setItem('rn_sid', sid); } catch {} }
let status = null, busy = false, identified = false;

async function api(path, { method = 'POST', body, headers = {} } = {}) {
  let res;
  try { res = await fetch(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }); }
  catch { throw new Error('Cannot reach the server. Is it running?'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.message) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return { ok: res.ok, data };
}

// ---------- status / banner ----------
async function loadStatus() {
  try {
    status = (await api('/api/status', { method: 'GET' })).data;
    const cd = $('#chip-data'), ca = $('#chip-ai');
    cd.textContent = status.mode === 'demo' ? 'DEMO DATA' : status.dataSourceOk ? 'Live Salesforce' : 'Salesforce: error';
    cd.className = 'chip ' + (status.mode === 'demo' ? 'demo' : status.dataSourceOk ? 'live' : 'off');
    ca.textContent = status.llmConfigured ? `AI: ${status.provider} · ${status.model}` : 'AI: not configured';
    ca.className = 'chip ' + (status.llmConfigured ? 'live' : 'off');
    const b = $('#banner');
    const msgs = [];
    if (status.llmConfigured && status.provider === 'gemini') msgs.push('Gemini free tier: Google may use prompts to improve its products - use demo or non-sensitive data only.');
    if (status.mode === 'demo') msgs.push('Demo mode: all vehicles, bookings and tickets shown here are built-in sample data - not from Salesforce.');
    if (!status.dataSourceOk) msgs.push(`Salesforce connection failed: ${status.dataSourceError}. Fix .env, or start with MODE=demo.`);
    if (!status.llmConfigured) msgs.push('The AI model is not configured (add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env), so chat is disabled.');
    b.hidden = !msgs.length; b.textContent = msgs.join(' '); b.className = 'banner' + (!status.dataSourceOk ? ' error' : '');
    $('#demo-hint').hidden = status.mode !== 'demo';
    renderSuggestions();
  } catch (e) { const b = $('#banner'); b.hidden = false; b.className = 'banner error'; b.textContent = e.message; }
}
function renderSuggestions() {
  const dt = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const list = ['What SUVs are free next weekend?', 'Show my bookings', 'I need an automatic car under ₹3000/day for 3 days from next Monday', 'Cancel my pending booking', 'My rental car broke down on the highway'];
  const box = $('#suggestions'); box.textContent = '';
  for (const t of list) { const b = el('button', null, t); b.type = 'button'; b.onclick = () => send(t); box.append(b); }
}

// ---------- identity ----------
async function identify(email) {
  const btn = $('#identify-btn'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api('/api/identify', { body: { sessionId: sid, email } });
    if (!r.ok) throw new Error(r.data.error);
    identified = true;
    $('#identity-status').textContent = `Signed in as ${r.data.customer.name} (matched by email only - not a password login).`;
    clearChat(); addBot(`Hi ${r.data.customer.name.split(' ')[0]}! How can I help with bookings or support today?`);
  } catch (e) { $('#identity-status').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Continue'; }
}
$('#identify-form').onsubmit = (e) => { e.preventDefault(); identify($('#email').value.trim()); };
document.addEventListener('click', (e) => { const em = e.target.dataset?.email; if (em) { $('#email').value = em; identify(em); } });

// ---------- chat rendering ----------
const log = $('#log');
function emptyState() {
  log.textContent = '';
  const d = el('div', 'empty');
  d.innerHTML = '<svg width="44" height="44" viewBox="0 0 32 32"><path d="M6 20l3-7h14l3 7v4h-3v-2H9v2H6z" fill="currentColor"/></svg>';
  d.append(el('div', null, 'Ask in plain language - find a car for your dates, check or cancel a booking, or report a problem.'));
  log.append(d);
}
function clearChat() { log.textContent = ''; }
function scroll() { log.scrollTop = log.scrollHeight; }
function ensureNotEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }
function addUser(t) { ensureNotEmpty(); const m = el('div', 'msg user'); m.append(el('div', 'bubble', t)); log.append(m); scroll(); }
function addBot(t, cls = '') { ensureNotEmpty(); const m = el('div', 'msg bot ' + cls); m.append(el('div', 'bubble', t)); log.append(m); scroll(); return m; }
function typing() { ensureNotEmpty(); const m = el('div', 'msg bot'); const b = el('div', 'bubble typing'); b.innerHTML = '<i></i><i></i><i></i>'; b.setAttribute('aria-label', 'Assistant is working'); m.append(b); log.append(m); scroll(); return m; }

function renderCards(card, m) {
  if (!card.items.length) { m.append(el('div', 'bubble muted', `${card.title}: nothing to show.`)); return; }
  const wrap = el('div'); wrap.append(el('div', 'cardtitle', card.title));
  const grid = el('div', 'cards');
  for (const it of card.items) {
    if (card.type === 'vehicles') {
      const c = el('div', 'vcard'); c.append(el('strong', null, it.label));
      const tags = el('div', 'tags'); for (const t of [it.type, it.fuel, it.transmission, `${it.seats} seats`]) if (t) tags.append(el('span', 'tag', t));
      c.append(tags, el('div', 'price', `${money(it.daily_rent)}/day · est. ${money(it.estimated_total)}`));
      const b = el('button', 'btn', 'Book this'); b.type = 'button';
      b.onclick = () => send(`I'd like to book the ${it.label} (vehicle id ${it.id}) from ${card.start_date} to ${card.end_date}.`);
      c.append(b);
      grid.append(c);
    } else {
      const c = el('div', 'bcard'); c.append(el('span', 'badge ' + it.status, it.status), el('strong', null, it.ref));
      c.append(el('div', null, it.vehicle ?? '—'), el('div', 'muted small', `${it.pickup_date} → ${it.return_date}`), el('div', 'small', `${money(it.total_rent)} · payment ${it.payment_status ?? '—'}`));
      grid.append(c);
    }
  }
  wrap.append(grid); m.append(wrap);
}
function renderSteps(steps, m) {
  if (!steps.length) return;
  const w = el('div', 'steps'); w.setAttribute('aria-label', 'Agent steps');
  for (const s of steps) { const c = el('span', 'step' + (s.ok ? '' : ' bad')); const b = el('b', null, s.label + ': '); c.append(b, document.createTextNode(s.detail)); w.append(c); }
  m.append(w);
}
function renderConfirm(p, m) {
  const box = el('div', 'confirm'); box.append(el('h3', null, p.preview.title));
  const dl = el('dl'); for (const [k, v] of p.preview.rows) { dl.append(el('dt', null, k), el('dd', null, v)); } box.append(dl);
  for (const w of p.preview.warnings || []) box.append(el('div', 'warn', w));
  const acts = el('div', 'actions'); const ok = el('button', 'btn primary', 'Confirm'); const no = el('button', 'btn', 'Cancel');
  ok.type = no.type = 'button'; acts.append(ok, no); box.append(acts);
  const lock = () => { ok.disabled = no.disabled = true; };
  ok.onclick = async () => {
    lock(); ok.textContent = 'Working…';
    try {
      const r = await api('/api/confirm', { body: { sessionId: sid, actionId: p.id } });
      box.classList.add('done'); ok.textContent = r.ok ? 'Confirmed' : 'Not completed';
      const msg = addBot(r.data.message || r.data.error, r.ok ? 'ok' : 'error');
      if (r.ok && r.data.card) renderCards(r.data.card, msg);
    } catch (e) { box.classList.add('done'); addBot(e.message, 'error'); }
  };
  no.onclick = async () => { lock(); box.classList.add('done'); try { const r = await api('/api/reject', { body: { sessionId: sid, actionId: p.id } }); addBot(r.data.message || 'Cancelled.'); } catch (e) { addBot(e.message, 'error'); } };
  m.append(box);
}

async function send(text) {
  text = (text ?? $('#input').value).trim();
  if (!text || busy) return;
  busy = true; $('#send').disabled = true; $('#input').value = ''; autosize();
  document.querySelectorAll('.confirm:not(.done)').forEach((c) => c.classList.add('done')); // an older unconfirmed card is replaced by new messages
  addUser(text); const t = typing();
  try {
    const r = await api('/api/chat', { body: { sessionId: sid, message: text } });
    t.remove();
    if (!r.ok) { addBot(r.data.error || 'Something went wrong.', 'error'); return; }
    const m = addBot(r.data.reply);
    renderSteps(r.data.steps, m); for (const c of r.data.cards) renderCards(c, m);
    if (r.data.pending) renderConfirm(r.data.pending, m);
    scroll();
  } catch (e) { t.remove(); addBot(e.message, 'error'); }
  finally { busy = false; $('#send').disabled = false; $('#input').focus(); }
}
$('#chat-form').onsubmit = (e) => { e.preventDefault(); send(); };
const ta = $('#input');
const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
ta.addEventListener('input', autosize);
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#reset').onclick = async () => { await api('/api/reset', { body: { sessionId: sid } }).catch(() => {}); emptyState(); };

// ---------- tabs ----------
function showTab(name) {
  const chat = name === 'chat';
  $('#view-chat').hidden = !chat; $('#view-admin').hidden = chat;
  $('#tab-chat').classList.toggle('active', chat); $('#tab-admin').classList.toggle('active', !chat);
  $('#tab-chat').setAttribute('aria-selected', chat); $('#tab-admin').setAttribute('aria-selected', !chat);
}
$('#tab-chat').onclick = () => showTab('chat'); $('#tab-admin').onclick = () => showTab('admin');

// ---------- admin ----------
let adminToken = ''; try { adminToken = sessionStorage.getItem('rn_admin') || ''; } catch {}
$('#admin-token').value = adminToken;
const state = (msg, cls = '') => { const s = $('#admin-state'); s.textContent = msg; s.className = 'state ' + cls; s.hidden = !msg; };
function table(cols, rows, emptyMsg) {
  if (!rows.length) return el('div', 'emptyrow', emptyMsg);
  const t = el('table'); const h = el('tr'); for (const c of cols) h.append(el('th', null, c.h)); t.append(h);
  for (const r of rows) { const tr = el('tr'); for (const c of cols) { const td = el('td'); c.cell(r, td); tr.append(td); } t.append(tr); }
  return t;
}
const flags = (r, td) => { for (const f of r.flags) td.append(el('span', 'flag', f)); if (!r.flags.length) td.textContent = '—'; };
async function loadAdmin(e) {
  e?.preventDefault();
  adminToken = $('#admin-token').value.trim(); try { sessionStorage.setItem('rn_admin', adminToken); } catch {}
  $('#admin-body').hidden = true; $('#ai-summary').disabled = true; $('#summary-box').hidden = true; state('Loading records…');
  try {
    const r = await api('/api/admin/insights', { method: 'GET', headers: { 'x-admin-token': adminToken } });
    if (!r.ok) throw new Error(r.data.error);
    const d = r.data; state('');
    $('#admin-source').textContent = `Source: ${d.source} · as of ${d.today}` + (d.mode === 'demo' ? ' · SAMPLE DATA, not Salesforce' : '');
    const st = $('#stats'); st.textContent = '';
    for (const [n, label, alert] of [[d.totals.pendingBookings, 'Pending bookings'], [money(d.totals.pendingRent), 'Pending rent value'], [d.totals.openTickets, 'Open tickets'], [d.totals.urgentTickets, 'Critical / High tickets', d.totals.urgentTickets > 0], [d.totals.needAttention, 'Items needing attention', d.totals.needAttention > 0]]) {
      const s = el('div', 'stat' + (alert ? ' alert' : '')); s.append(el('b', null, String(n)), el('span', null, label)); st.append(s);
    }
    $('#tbl-bookings').replaceChildren(table([{ h: 'Ref', cell: (r, td) => td.textContent = r.ref }, { h: 'Customer', cell: (r, td) => td.textContent = r.customer ?? '—' }, { h: 'Vehicle', cell: (r, td) => td.textContent = r.vehicle ?? '—' },
      { h: 'Dates', cell: (r, td) => td.textContent = `${r.pickupDate} → ${r.returnDate}` }, { h: 'Rent', cell: (r, td) => td.textContent = money(r.totalRent) }, { h: 'Flags', cell: flags }], d.pendingBookings, 'No pending bookings. Nice and clear.'));
    $('#tbl-tickets').replaceChildren(table([{ h: 'Ticket', cell: (r, td) => td.textContent = r.ref }, { h: 'Priority', cell: (r, td) => { td.textContent = r.priority; td.className = 'prio-' + r.priority; } }, { h: 'Issue', cell: (r, td) => td.textContent = r.issueType },
      { h: 'Booking', cell: (r, td) => td.textContent = r.booking ?? '—' }, { h: 'Status', cell: (r, td) => td.textContent = r.status + (r.assignedTo ? ` · ${r.assignedTo}` : '') }, { h: 'Flags', cell: flags }], d.openTickets, 'No open support tickets.'));
    $('#admin-body').hidden = false; $('#ai-summary').disabled = !status?.llmConfigured;
  } catch (err) { state(err.message, 'error'); }
}
$('#admin-form').onsubmit = loadAdmin;
$('#ai-summary').onclick = async () => {
  const b = $('#ai-summary'); b.disabled = true; b.textContent = 'Summarising…'; const box = $('#summary-box'); box.hidden = true;
  try {
    const r = await api('/api/admin/summary', { headers: { 'x-admin-token': adminToken } });
    if (!r.ok) throw new Error(r.data.error);
    box.replaceChildren(el('h2', null, 'AI summary (generated from the records below)'), el('div', null, r.data.summary)); box.hidden = false;
  } catch (e) { box.replaceChildren(el('div', 'state error', e.message)); box.hidden = false; }
  finally { b.disabled = false; b.textContent = 'AI summary'; }
};

emptyState(); loadStatus();
