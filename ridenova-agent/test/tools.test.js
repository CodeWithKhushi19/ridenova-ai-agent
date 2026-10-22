import test from 'node:test';
import assert from 'node:assert/strict';
import { makeToolbox, session, d, AARAV, PRIYA, V, TODAY } from './helpers.js';

const search = (tb, s, a) => tb.toolbox.runTool(s, 'search_vehicles', a);

test('search excludes blocked statuses, clashing bookings and expiring documents', async () => {
  const tb = makeToolbox(); const s = session(null);
  const r = await search(tb, s, { start_date: d(2), end_date: d(4) });
  assert.ok(r.ok);
  const ids = r.vehicles.map((v) => v.id);
  assert.ok(!ids.includes(V(6)), 'Under Maintenance vehicle must not be offered');
  assert.ok(!ids.includes(V(10)), 'Out of Service vehicle must not be offered');
  assert.ok(!ids.includes(V(3)), 'Innova has a Confirmed booking in range');
  assert.ok(!ids.includes(V(2)), 'Creta has a Pending booking in range');
  assert.ok(ids.includes(V(1)));
  assert.equal(r.excluded_already_booked, 2);
  const far = await search(tb, s, { start_date: d(95), end_date: d(100) });
  assert.ok(far.excluded_documents_expiring >= 1);
  assert.ok(!far.vehicles.some((v) => v.id === V(3)), 'insurance expires day 90');
});
test('search validates input', async () => {
  const tb = makeToolbox(); const s = session(null);
  assert.equal((await search(tb, s, { start_date: d(-1), end_date: d(2) })).error, 'start_date_in_past');
  assert.equal((await search(tb, s, { start_date: d(3), end_date: d(3) })).error, 'end_date_must_be_after_start_date');
  assert.equal((await search(tb, s, { start_date: 'tomorrow', end_date: d(3) })).error, 'invalid_date_format');
  assert.equal((await search(tb, s, { start_date: d(3), end_date: d(4), vehicle_type: 'Spaceship' })).error, 'invalid_type');
  const suv = await search(tb, s, { start_date: d(20), end_date: d(22), vehicle_type: 'SUV', transmission: 'Automatic', max_daily_rent: 3100 });
  assert.ok(suv.vehicles.every((v) => v.type === 'SUV' && v.transmission === 'Automatic' && v.daily_rent <= 3100));
  assert.equal(suv.vehicles[0].estimated_total, suv.vehicles[0].daily_rent * 2);
});
test('writes require identification', async () => {
  const { toolbox } = makeToolbox(); const s = session(null);
  for (const [n, a] of [['get_my_bookings', {}], ['propose_booking', { vehicle_id: V(1), pickup_date: d(5), return_date: d(6), pickup_location: 'A', drop_location: 'B' }],
    ['propose_cancellation', { booking_ref: 'BKG-00001' }], ['propose_support_ticket', { booking_ref: 'BKG-00001', issue_type: 'Other', priority: 'Low', summary: 'hello there' }]]) {
    assert.equal((await toolbox.runTool(s, n, a)).error, 'customer_not_identified', n);
  }
});
test('propose_* never writes; confirm writes exactly once', async () => {
  const tb = makeToolbox(); const s = session(AARAV);
  const before = tb.repo.bookings.length;
  const p = await tb.toolbox.runTool(s, 'propose_booking', { vehicle_id: V(5), pickup_date: d(20), return_date: d(23), pickup_location: 'Airport', drop_location: 'Hotel' });
  assert.equal(p.status, 'awaiting_user_confirmation');
  assert.equal(tb.repo.bookings.length, before, 'proposal must not write');
  const id = s.pending.id;
  const c = await tb.toolbox.confirm(s, id);
  assert.ok(c.ok, c.message);
  assert.equal(tb.repo.bookings.length, before + 1);
  const created = tb.repo.bookings.at(-1);
  assert.equal(created.status, 'Pending'); assert.equal(created.totalRent, 3000 * 3); assert.equal(created.customerId, AARAV);
  const again = await tb.toolbox.confirm(s, id);
  assert.equal(again.ok, false); assert.equal(tb.repo.bookings.length, before + 1, 'replay must not duplicate');
});
test('confirm rejects wrong/unknown action ids and expired actions', async () => {
  const tb = makeToolbox(); const s = session(AARAV);
  await tb.toolbox.runTool(s, 'propose_booking', { vehicle_id: V(5), pickup_date: d(20), return_date: d(21), pickup_location: 'A1', drop_location: 'B1' });
  assert.equal((await tb.toolbox.confirm(s, 'not-the-id')).ok, false);
  assert.ok(s.pending, 'wrong id must not consume the pending action');
  s.pending.expiresAt = Date.now() - 1;
  const r = await tb.toolbox.confirm(s, s.pending.id);
  assert.equal(r.error, 'expired');
  const n = tb.repo.bookings.length; assert.equal(n, 6);
});
test('booking validation: dates, length, overlap, duplicates, stale re-check', async () => {
  const tb = makeToolbox(); const a = session(AARAV); const p = session(PRIYA);
  const base = { vehicle_id: V(5), pickup_location: 'Airport', drop_location: 'Airport' };
  const bad = (x) => tb.toolbox.runTool(a, 'propose_booking', { ...base, ...x });
  assert.equal((await bad({ pickup_date: d(-1), return_date: d(2) })).error, 'pickup_date_in_past');
  assert.equal((await bad({ pickup_date: d(5), return_date: d(5) })).error, 'return_must_be_after_pickup');
  assert.equal((await bad({ pickup_date: d(5), return_date: d(60) })).error, 'stay_too_long');
  assert.equal((await bad({ vehicle_id: 'a00NOPE', pickup_date: d(5), return_date: d(6) })).error, 'invalid_vehicle_id');
  assert.equal((await bad({ vehicle_id: 'a00DEMO00000000099', pickup_date: d(5), return_date: d(6) })).error, 'vehicle_not_found');
  assert.equal((await bad({ vehicle_id: V(6), pickup_date: d(5), return_date: d(6) })).error, 'vehicle_unavailable');
  assert.equal((await bad({ vehicle_id: V(2), pickup_date: d(4), return_date: d(6) })).error, 'vehicle_already_booked_for_these_dates');
  assert.equal((await bad({ pickup_location: '', pickup_date: d(5), return_date: d(6) })).error, 'invalid_pickup_location');
  // Aarav proposes, Priya books the same vehicle first -> Aarav's confirm must fail on re-validation
  assert.equal((await bad({ pickup_date: d(30), return_date: d(31) })).status, 'awaiting_user_confirmation');
  const aaravId = a.pending.id;
  await tb.toolbox.runTool(p, 'propose_booking', { ...base, pickup_date: d(30), return_date: d(31) });
  assert.ok((await tb.toolbox.confirm(p, p.pending.id)).ok);
  const stale = await tb.toolbox.confirm(a, aaravId);
  assert.equal(stale.ok, false); assert.equal(stale.error, 'vehicle_already_booked_for_these_dates');
  assert.equal(tb.repo.bookings.filter((b) => b.vehicleId === V(5) && b.pickupDate === d(30)).length, 1);
  // duplicate by same customer
  assert.equal((await tb.toolbox.runTool(p, 'propose_booking', { ...base, pickup_date: d(30), return_date: d(31) })).error, 'duplicate_or_overlapping_booking_by_this_customer');
});
test('cancellation: ownership, status, trip started, confirm', async () => {
  const tb = makeToolbox(); const s = session(AARAV);
  const cancel = (ref) => tb.toolbox.runTool(s, 'propose_cancellation', { booking_ref: ref });
  assert.equal((await cancel('BKG-00002')).error, 'booking_not_found_for_this_customer', "someone else's booking");
  assert.equal((await cancel('BKG-99999')).error, 'booking_not_found_for_this_customer', 'same answer as not-owned: no leakage');
  assert.equal((await cancel("BKG-1' OR Name != '")).error, 'invalid_booking_ref');
  assert.equal((await cancel('BKG-00004')).error, 'booking_not_cancellable');
  const ok = await cancel('bkg-00006');
  assert.equal(ok.status, 'awaiting_user_confirmation');
  assert.equal(tb.repo.bookings.find((b) => b.ref === 'BKG-00006').status, 'Pending', 'not cancelled before confirm');
  assert.ok((await tb.toolbox.confirm(s, s.pending.id)).ok);
  assert.equal(tb.repo.bookings.find((b) => b.ref === 'BKG-00006').status, 'Cancelled');
  assert.equal((await cancel('BKG-00006')).error, 'booking_not_cancellable');
  const paid = await cancel('BKG-00001');
  assert.ok(paid.preview.warnings[0].includes('Partially Paid'), 'refund warning for paid bookings');
});
test('support tickets: enums, ownership, duplicates, creation', async () => {
  const tb = makeToolbox(); const s = session(AARAV);
  const t = (x) => tb.toolbox.runTool(s, 'propose_support_ticket', { booking_ref: 'BKG-00001', issue_type: 'Late Return', priority: 'Medium', summary: 'Car returned late by the driver', ...x });
  assert.equal((await t({ issue_type: 'Haunted' })).error, 'invalid_issue_type');
  assert.equal((await t({ priority: 'Urgent!!' })).error, 'invalid_priority');
  assert.equal((await t({ summary: 'x' })).error, 'invalid_summary_length');
  assert.equal((await t({ booking_ref: 'BKG-00002' })).error, 'booking_not_found_for_this_customer');
  assert.equal((await t({ issue_type: 'Payment Issue' })).error, 'similar_open_ticket_exists');
  const n = tb.repo.tickets.length;
  const ok = await t({});
  assert.equal(ok.status, 'awaiting_user_confirmation'); assert.equal(tb.repo.tickets.length, n);
  const c = await tb.toolbox.confirm(s, s.pending.id);
  assert.ok(c.ok); assert.equal(tb.repo.tickets.length, n + 1);
  assert.equal(tb.repo.tickets.at(-1).status, 'Open'); assert.equal(tb.repo.tickets.at(-1).ticketDate, TODAY);
});
test('a new proposal replaces the older pending one', async () => {
  const tb = makeToolbox(); const s = session(AARAV);
  await tb.toolbox.runTool(s, 'propose_cancellation', { booking_ref: 'BKG-00006' });
  const first = s.pending.id;
  await tb.toolbox.runTool(s, 'propose_booking', { vehicle_id: V(5), pickup_date: d(40), return_date: d(41), pickup_location: 'A1', drop_location: 'B1' });
  assert.notEqual(s.pending.id, first);
  assert.equal((await tb.toolbox.confirm(s, first)).ok, false);
});
test('unknown tools and bad args are handled', async () => {
  const { toolbox } = makeToolbox(); const s = session(AARAV);
  assert.equal((await toolbox.runTool(s, 'drop_database', {})).error, 'unknown_tool');
  assert.equal((await toolbox.runTool(s, 'propose_booking', null)).ok, false);
});
