// End-to-end over real HTTP: browser-style requests -> server -> agent loop -> tools -> demo repo.
// The LLM is a SCRIPTED STAND-IN (no network/API key in CI). This proves orchestration, validation and the
// confirmation gate - NOT the quality of real model decisions. See README "Live verification checklist".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { DemoRepo } from '../server/demo.js';
import { TODAY, d, V, scriptedLlm, use, say } from './helpers.js';

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

async function boot(script, { llm } = {}) {
  const config = loadConfig({ MODE: 'demo', ADMIN_TOKEN: 'secret-admin' });
  const repo = new DemoRepo(TODAY);
  const model = llm ?? scriptedLlm(script);
  const { server } = createApp({ config, repo, llm: model });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { repo, model, call, base, close: () => server.close() };
}
const SID = 'session-abcdef-123456';

test('status is honest about demo mode', async () => {
  const t = await boot([]); const r = await t.call('/api/status');
  assert.equal(r.body.mode, 'demo'); assert.match(r.body.dataSource, /not Salesforce/); assert.equal(r.body.llmConfigured, true); t.close();
});

test('full booking journey: search -> propose -> confirm; LLM never writes, duplicates blocked', async () => {
  const t = await boot([
    use('t1', 'search_vehicles', { start_date: d(20), end_date: d(23), vehicle_type: 'SUV', transmission: 'Automatic' }),
    say('I found a few automatic SUVs for those dates.'),
    use('t2', 'propose_booking', { vehicle_id: V(5), pickup_date: d(20), return_date: d(23), pickup_location: 'Airport', drop_location: 'Airport' }),
    say('Ready - please press Confirm to create the booking.'),
    use('t3', 'propose_booking', { vehicle_id: V(5), pickup_date: d(21), return_date: d(22), pickup_location: 'Airport', drop_location: 'Airport' }),
    say('That overlaps your new booking.'),
  ]);
  assert.equal((await t.call('/api/identify', { sessionId: SID, email: 'AARAV@example.com' })).body.customer.name, 'Aarav Sharma');
  const s = await t.call('/api/chat', { sessionId: SID, message: 'automatic SUV for 3 days from the 20th' });
  assert.equal(s.status, 200); assert.equal(s.body.steps[0].tool, 'search_vehicles'); assert.equal(s.body.cards[0].type, 'vehicles');
  assert.ok(s.body.cards[0].items.every((v) => v.type === 'SUV' && v.transmission === 'Automatic')); assert.equal(s.body.pending, null);
  // tool result handed to the LLM is JSON of the real search (second LLM call sees it)
  const toolResult = t.model.calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result'); assert.ok(JSON.parse(toolResult.content).matches >= 1);
  const before = t.repo.bookings.length;
  const p = await t.call('/api/chat', { sessionId: SID, message: 'book the Nexon EV, airport to airport' });
  assert.equal(p.body.pending.type, 'booking'); assert.equal(t.repo.bookings.length, before, 'LLM-driven proposal must not write');
  const c1 = await t.call('/api/confirm', { sessionId: SID, actionId: p.body.pending.id });
  assert.equal(c1.status, 200); assert.equal(c1.body.record.status, 'Pending'); assert.equal(t.repo.bookings.length, before + 1);
  const c2 = await t.call('/api/confirm', { sessionId: SID, actionId: p.body.pending.id });
  assert.equal(c2.status, 409); assert.equal(t.repo.bookings.length, before + 1, 'double confirm must not duplicate');
  const dup = await t.call('/api/chat', { sessionId: SID, message: 'book it again for the 21st' });
  assert.equal(dup.body.pending, null); assert.equal(dup.body.steps[0].ok, false); assert.match(dup.body.steps[0].detail, /overlapping booking/);
  t.close();
});

test("cannot touch another customer's booking, even if the LLM tries", async () => {
  const t = await boot([use('a', 'propose_cancellation', { booking_ref: 'BKG-00002' }), say('I could not find that booking on your account.')]);
  await t.call('/api/identify', { sessionId: SID, email: 'aarav@example.com' });
  const r = await t.call('/api/chat', { sessionId: SID, message: "cancel Priya's booking BKG-00002" });
  assert.equal(r.body.pending, null); assert.equal(t.repo.bookings.find((b) => b.ref === 'BKG-00002').status, 'Pending');
  assert.match(r.body.steps[0].detail, /booking not found for this customer/);
  // and a confirm attempt with a guessed id from another session fails
  const x = await t.call('/api/confirm', { sessionId: 'other-session-123456', actionId: 'guess' });
  assert.equal(x.status, 409); t.close();
});

test('support ticket flow with classification supplied by the model and enforced by the backend', async () => {
  const t = await boot([
    use('a', 'propose_support_ticket', { booking_ref: 'BKG-00001', issue_type: 'Vehicle Damage', priority: 'High', summary: 'Scratch on the left door when delivered' }), say('Please confirm the ticket.'),
    use('b', 'propose_support_ticket', { booking_ref: 'BKG-00001', issue_type: 'Meteor Strike', priority: 'High', summary: 'invalid enum test' }), say('That category is not valid, let me retry.'),
  ]);
  await t.call('/api/identify', { sessionId: SID, email: 'aarav@example.com' });
  const n = t.repo.tickets.length;
  const r = await t.call('/api/chat', { sessionId: SID, message: 'car has a scratch' });
  assert.equal(r.body.pending.type, 'ticket'); assert.equal(t.repo.tickets.length, n);
  const c = await t.call('/api/confirm', { sessionId: SID, actionId: r.body.pending.id });
  assert.equal(c.status, 200); assert.equal(t.repo.tickets.at(-1).priority, 'High'); assert.equal(t.repo.tickets.length, n + 1);
  const bad = await t.call('/api/chat', { sessionId: SID, message: 'another' });
  assert.equal(bad.body.pending, null); assert.match(bad.body.steps[0].detail, /invalid issue type/); t.close();
});

test('declining leaves data unchanged', async () => {
  const t = await boot([use('a', 'propose_cancellation', { booking_ref: 'BKG-00006' }), say('Press Confirm to cancel.')]);
  await t.call('/api/identify', { sessionId: SID, email: 'aarav@example.com' });
  const r = await t.call('/api/chat', { sessionId: SID, message: 'cancel BKG-00006' });
  const x = await t.call('/api/reject', { sessionId: SID, actionId: r.body.pending.id });
  assert.equal(x.body.ok, true); assert.equal(t.repo.bookings.find((b) => b.ref === 'BKG-00006').status, 'Pending');
  assert.equal((await t.call('/api/confirm', { sessionId: SID, actionId: r.body.pending.id })).status, 409); t.close();
});

test('unidentified customers cannot reach private data; unknown email gives clear error', async () => {
  const t = await boot([use('a', 'get_my_bookings', {}), say('Please enter your email first.')]);
  const r = await t.call('/api/chat', { sessionId: SID, message: 'show my bookings' });
  assert.equal(r.body.steps[0].ok, false); assert.match(r.body.steps[0].detail, /customer not identified/);
  assert.equal((await t.call('/api/identify', { sessionId: SID, email: 'nobody@example.com' })).status, 404);
  assert.equal((await t.call('/api/identify', { sessionId: SID, email: "x'; DROP" })).status, 400); t.close();
});

test('errors: AI not configured, AI failure rolls back history, bad input, oversize, bad session', async () => {
  const off = await boot([], { llm: { configured: false, complete: async () => { throw new Error('unused'); } } });
  const r = await off.call('/api/chat', { sessionId: SID, message: 'hi' });
  assert.equal(r.status, 503); assert.match(r.body.error, /not configured/); off.close();
  const boom = await boot([() => { throw Object.assign(new Error('upstream down'), { status: 502 }); }, say('recovered')]);
  const f = await boom.call('/api/chat', { sessionId: SID, message: 'hello' });
  assert.equal(f.status, 502); assert.match(f.body.error, /AI service/);
  const ok = await boom.call('/api/chat', { sessionId: SID, message: 'hello again' });
  assert.equal(ok.status, 200); assert.equal(ok.body.reply, 'recovered');
  assert.deepEqual(boom.model.calls[1].messages.map((m) => m.role), ['user'], 'failed turn was rolled back');
  assert.equal((await boom.call('/api/chat', { sessionId: SID, message: '   ' })).status, 400);
  assert.equal((await boom.call('/api/chat', { sessionId: SID, message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await boom.call('/api/chat', { sessionId: '../etc', message: 'hi' })).status, 400);
  const big = await fetch(boom.base + '/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: SID, message: 'a'.repeat(30000) }) });
  assert.equal(big.status, 413); boom.close();
});

test('agent loop is bounded when the model keeps calling tools', async () => {
  const script = Array.from({ length: 10 }, (_, i) => use(`l${i}`, 'get_my_bookings', {}));
  const t = await boot(script); await t.call('/api/identify', { sessionId: SID, email: 'aarav@example.com' });
  const r = await t.call('/api/chat', { sessionId: SID, message: 'loop' });
  assert.equal(r.status, 200); assert.match(r.body.reply, /stuck/); assert.equal(r.body.steps.length, 6); t.close();
});

test('admin insights are token-protected and computed from retrieved records', async () => {
  const t = await boot([]);
  assert.equal((await t.call('/api/admin/insights')).status, 401);
  assert.equal((await t.call('/api/admin/insights', undefined, { 'x-admin-token': 'wrong' })).status, 401);
  const r = await t.call('/api/admin/insights', undefined, { 'x-admin-token': 'secret-admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.pendingBookings, 3); assert.equal(r.body.totals.openTickets, 3); assert.equal(r.body.totals.urgentTickets, 2);
  assert.equal(r.body.openTickets[0].priority, 'Critical', 'sorted by priority');
  assert.ok(r.body.openTickets.find((x) => x.ref === 'TKT-0001').flags.includes('Urgent & unassigned'));
  assert.equal(r.body.pendingBookings.find((b) => b.ref === 'BKG-00002').flags.some((f) => /Pickup in 3/.test(f)), true);
  assert.equal(r.body.pendingRent, undefined); assert.equal(r.body.totals.pendingRent, 6400 + 5200 + 9300);
  const sum = await boot([say('- Two urgent tickets need assignment first.')]);
  const s = await sum.call('/api/admin/summary', {}, { 'x-admin-token': 'secret-admin' });
  assert.match(s.body.summary, /urgent/);
  assert.ok(JSON.parse(sum.model.calls[0].messages[0].content).totals.openTickets === 3, 'summary prompt is built from the retrieved records');
  assert.equal((await sum.call('/api/admin/summary', {})).status, 401); t.close(); sum.close();
});

test('static serving blocks path traversal and sets security headers', async () => {
  const t = await boot([]);
  const home = await fetch(t.base + '/'); assert.equal(home.status, 200); assert.ok(home.headers.get('content-security-policy'));
  assert.equal((await fetch(t.base + '/..%2fserver%2fconfig.js')).status, 404);
  assert.equal((await fetch(t.base + '/%2e%2e/.env.example')).status, 404);
  assert.equal((await fetch(t.base + '/app.js')).status, 200); t.close();
});
