// Tool layer: the ONLY code the LLM can reach. Read tools run immediately; write tools only create a
// *pending action*. The write happens in confirm(), which the browser triggers (never the LLM) and which
// re-validates everything against fresh data before touching Salesforce.
import crypto from 'node:crypto';
import { ENUMS } from './schema.js';
import { isIsoDate, daysBetween, rangesOverlap, normBookingRef, isBookingRef, isSfId, money } from './util.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_STAY_DAYS = 30;

export const TOOL_DEFS = [
  { name: 'search_vehicles',
    description: 'Search vehicles that are genuinely free for a date range (checks vehicle status, expiry of insurance/RC and clashing Pending/Confirmed bookings). Both dates are required - ask the customer if they did not give them. Does not need customer identification.',
    input_schema: { type: 'object', properties: {
      start_date: { type: 'string', description: 'Pickup date, YYYY-MM-DD' },
      end_date: { type: 'string', description: 'Return date, YYYY-MM-DD (must be after start_date)' },
      vehicle_type: { type: 'string', enum: ENUMS.vehicleType }, brand: { type: 'string', enum: ENUMS.brand },
      fuel_type: { type: 'string', enum: ENUMS.fuelType }, transmission: { type: 'string', enum: ENUMS.transmission },
      min_seats: { type: 'integer', minimum: 1, maximum: 15 }, max_daily_rent: { type: 'number', minimum: 1 } },
      required: ['start_date', 'end_date'] } },
  { name: 'get_my_bookings', description: "List the identified customer's own bookings (latest 20). Requires customer identification.", input_schema: { type: 'object', properties: {} } },
  { name: 'get_booking', description: "Look up one of the identified customer's bookings by reference like BKG-00012.",
    input_schema: { type: 'object', properties: { booking_ref: { type: 'string' } }, required: ['booking_ref'] } },
  { name: 'propose_booking',
    description: 'Validate a booking and prepare it for the customer to confirm. This does NOT create the booking; the customer must press Confirm in the UI. Use a vehicle id returned by search_vehicles. The booking is created as Pending (staff confirm it later).',
    input_schema: { type: 'object', properties: {
      vehicle_id: { type: 'string' }, pickup_date: { type: 'string' }, return_date: { type: 'string' },
      pickup_location: { type: 'string' }, drop_location: { type: 'string' } },
      required: ['vehicle_id', 'pickup_date', 'return_date', 'pickup_location', 'drop_location'] } },
  { name: 'propose_cancellation',
    description: "Validate cancelling one of the customer's bookings and prepare it for confirmation. Does NOT cancel; the customer must press Confirm in the UI.",
    input_schema: { type: 'object', properties: { booking_ref: { type: 'string' } }, required: ['booking_ref'] } },
  { name: 'propose_support_ticket',
    description: "Classify a support request and prepare a ticket linked to one of the customer's bookings. Does NOT create it; the customer must press Confirm in the UI.",
    input_schema: { type: 'object', properties: {
      booking_ref: { type: 'string' }, issue_type: { type: 'string', enum: ENUMS.issueType }, priority: { type: 'string', enum: ENUMS.priority },
      summary: { type: 'string', description: "Short factual summary of the customer's problem (5-500 chars)" } },
      required: ['booking_ref', 'issue_type', 'priority', 'summary'] } },
];

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const vehicleLabel = (v) => `${v.brand ?? ''} ${v.model ?? v.name ?? ''}`.trim();

export function createToolbox({ repo, today }) {
  let writeLock = Promise.resolve();
  const serial = (fn) => { const run = writeLock.then(fn, fn); writeLock = run.catch(() => {}); return run; };

  function needCustomer(session) {
    return session.customer ? null : fail('customer_not_identified', { hint: 'Ask the customer to enter their registered email in the identification box. Do not guess or ask them to type someone else\'s details.' });
  }

  async function ownBooking(session, rawRef) {
    const ref = normBookingRef(rawRef);
    if (!isBookingRef(ref)) return { err: fail('invalid_booking_ref', { hint: 'Booking references look like BKG-00012' }) };
    const b = await repo.getBookingByRef(ref);
    // Same message for "does not exist" and "belongs to someone else" - never reveal other customers' bookings.
    if (!b || b.customerId !== session.customer.id) return { err: fail('booking_not_found_for_this_customer') };
    return { booking: b };
  }

  // ---------- validation shared by propose_* (preview) and confirm (re-check) ----------
  async function prepareBooking(session, a) {
    const c = needCustomer(session); if (c) return c;
    const t = today();
    if (!isSfId(a.vehicle_id)) return fail('invalid_vehicle_id', { hint: 'Use the id from search_vehicles' });
    if (!isIsoDate(a.pickup_date) || !isIsoDate(a.return_date)) return fail('invalid_date_format', { hint: 'Use YYYY-MM-DD' });
    if (a.pickup_date < t) return fail('pickup_date_in_past', { today: t });
    if (a.return_date <= a.pickup_date) return fail('return_must_be_after_pickup');
    const days = daysBetween(a.pickup_date, a.return_date);
    if (days > MAX_STAY_DAYS) return fail('stay_too_long', { max_days: MAX_STAY_DAYS });
    for (const k of ['pickup_location', 'drop_location']) {
      if (typeof a[k] !== 'string' || a[k].trim().length < 2 || a[k].length > 100) return fail(`invalid_${k}`);
    }
    const v = await repo.getVehicle(a.vehicle_id);
    if (!v) return fail('vehicle_not_found');
    if (ENUMS.vehicleBlockedStatuses.includes(v.status)) return fail('vehicle_unavailable', { reason: v.status });
    if ((v.insuranceExpiry && v.insuranceExpiry < a.return_date) || (v.rcExpiry && v.rcExpiry < a.return_date)) return fail('vehicle_documents_expire_before_return');
    if (!(v.dailyRent > 0)) return fail('vehicle_has_no_valid_daily_rent');
    const clashes = await repo.findActiveBookingsOverlapping([v.id], a.pickup_date, a.return_date);
    if (clashes.length) {
      const mine = clashes.find((x) => x.customerId === session.customer.id);
      return fail(mine ? 'duplicate_or_overlapping_booking_by_this_customer' : 'vehicle_already_booked_for_these_dates', mine ? { existing_booking: mine.ref } : {});
    }
    const totalRent = v.dailyRent * days;
    const normalized = { customerId: session.customer.id, vehicleId: v.id, bookingDate: t, pickupDate: a.pickup_date, returnDate: a.return_date,
      pickupLocation: a.pickup_location.trim(), dropLocation: a.drop_location.trim(), totalRent, securityDeposit: v.securityDeposit ?? null };
    return { ok: true, normalized, preview: { title: 'Create booking', rows: [
      ['Vehicle', `${vehicleLabel(v)} (${v.type}, ${v.fuel}, ${v.transmission})`], ['Pickup', `${a.pickup_date} · ${normalized.pickupLocation}`],
      ['Return', `${a.return_date} · ${normalized.dropLocation}`], ['Duration', `${days} day${days > 1 ? 's' : ''} × ${money(v.dailyRent)}`],
      ['Total rent', money(totalRent)], ['Security deposit', v.securityDeposit ? money(v.securityDeposit) : 'None listed'], ['Customer', session.customer.name]],
      warnings: ['Booking will be created as "Pending" and must be confirmed by RideNova staff. Payment is not taken here.'] } };
  }

  async function prepareCancellation(session, a) {
    const c = needCustomer(session); if (c) return c;
    const { booking: b, err } = await ownBooking(session, a.booking_ref); if (err) return err;
    if (!ENUMS.bookingActiveStatuses.includes(b.status)) return fail('booking_not_cancellable', { current_status: b.status });
    if (b.pickupDate < today()) return fail('trip_already_started', { hint: 'Contact support; a ticket can be raised.' });
    const warnings = [];
    if (b.paymentStatus && b.paymentStatus !== 'Pending') warnings.push(`Payment status is "${b.paymentStatus}". Refunds are handled by support - raise a Refund Request after cancelling.`);
    return { ok: true, normalized: { bookingId: b.id, ref: b.ref }, preview: { title: `Cancel booking ${b.ref}`, rows: [
      ['Booking', b.ref], ['Vehicle', b.vehicleName ?? '—'], ['Dates', `${b.pickupDate} → ${b.returnDate}`], ['Current status', b.status], ['Total rent', money(b.totalRent)]], warnings } };
  }

  async function prepareTicket(session, a) {
    const c = needCustomer(session); if (c) return c;
    if (!ENUMS.issueType.includes(a.issue_type)) return fail('invalid_issue_type', { allowed: ENUMS.issueType });
    if (!ENUMS.priority.includes(a.priority)) return fail('invalid_priority', { allowed: ENUMS.priority });
    const summary = typeof a.summary === 'string' ? a.summary.trim() : '';
    if (summary.length < 5 || summary.length > 500) return fail('invalid_summary_length');
    const { booking: b, err } = await ownBooking(session, a.booking_ref); if (err) return err;
    const dup = await repo.findOpenTickets(b.id, a.issue_type);
    if (dup.length) return fail('similar_open_ticket_exists', { existing_ticket: dup[0].ref, status: dup[0].status });
    const warnings = repo.ticketDescriptionEnabled ? [] : ['Your description is used to classify the ticket, but this Salesforce org has no field configured to store it - support will see only the type, priority and booking.'];
    return { ok: true, normalized: { customerId: session.customer.id, bookingId: b.id, issueType: a.issue_type, priority: a.priority, ticketDate: today(), description: summary },
      preview: { title: 'Create support ticket', rows: [['Booking', b.ref], ['Issue type', a.issue_type], ['Priority', a.priority], ['Your description', summary]], warnings } };
  }

  const PREPARE = { booking: prepareBooking, cancellation: prepareCancellation, ticket: prepareTicket };

  function stage(session, type, prepared, rawArgs) {
    if (!prepared.ok) return prepared;
    const action = { id: crypto.randomUUID(), type, rawArgs, preview: prepared.preview, expiresAt: Date.now() + PENDING_TTL_MS };
    session.pending = action; // a new proposal replaces any older unconfirmed one
    return { ok: true, status: 'awaiting_user_confirmation', note: 'NOT executed. The customer must press Confirm in the UI. Summarise the details briefly and ask them to confirm; do not claim it is done.', preview: prepared.preview };
  }

  // ---------- tools exposed to the LLM ----------
  const impl = {
    async search_vehicles(session, a) {
      if (!isIsoDate(a.start_date) || !isIsoDate(a.end_date)) return fail('invalid_date_format', { hint: 'Use YYYY-MM-DD' });
      if (a.start_date < today()) return fail('start_date_in_past', { today: today() });
      if (a.end_date <= a.start_date) return fail('end_date_must_be_after_start_date');
      const f = { type: a.vehicle_type, brand: a.brand, fuel: a.fuel_type, transmission: a.transmission, minSeats: a.min_seats, maxDailyRent: a.max_daily_rent };
      for (const [k, list] of [['type', ENUMS.vehicleType], ['brand', ENUMS.brand], ['fuel', ENUMS.fuelType], ['transmission', ENUMS.transmission]]) {
        if (f[k] && !list.includes(f[k])) return fail(`invalid_${k}`, { allowed: list });
      }
      for (const k of ['minSeats', 'maxDailyRent']) if (f[k] != null && !(Number(f[k]) > 0)) return fail(`invalid_${k}`);
      const candidates = await repo.searchVehicles(f);
      const clashes = await repo.findActiveBookingsOverlapping(candidates.map((v) => v.id), a.start_date, a.end_date);
      const busy = new Set(clashes.filter((b) => rangesOverlap(a.start_date, a.end_date, b.pickupDate, b.returnDate)).map((b) => b.vehicleId));
      let expired = 0;
      const free = candidates.filter((v) => {
        if (busy.has(v.id)) return false;
        if ((v.insuranceExpiry && v.insuranceExpiry < a.end_date) || (v.rcExpiry && v.rcExpiry < a.end_date)) { expired++; return false; }
        return true;
      });
      const days = daysBetween(a.start_date, a.end_date);
      const vehicles = free.map((v) => ({ id: v.id, label: vehicleLabel(v), type: v.type, fuel: v.fuel, transmission: v.transmission, seats: v.seats,
        daily_rent: v.dailyRent, security_deposit: v.securityDeposit, estimated_total: v.dailyRent * days }));
      return { ok: true, start_date: a.start_date, end_date: a.end_date, days, matches: vehicles.length,
        excluded_already_booked: busy.size, excluded_documents_expiring: expired, vehicles,
        card: { type: 'vehicles', start_date: a.start_date, end_date: a.end_date, title: `${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'} free ${a.start_date} → ${a.end_date}`, items: vehicles } };
    },
    async get_my_bookings(session) {
      const c = needCustomer(session); if (c) return c;
      const rows = await repo.listBookingsForCustomer(session.customer.id);
      const items = rows.map(bookingView);
      return { ok: true, count: items.length, bookings: items, card: { type: 'bookings', title: `Your bookings (${items.length})`, items } };
    },
    async get_booking(session, a) {
      const c = needCustomer(session); if (c) return c;
      const { booking, err } = await ownBooking(session, a.booking_ref); if (err) return err;
      return { ok: true, booking: bookingView(booking), card: { type: 'bookings', title: booking.ref, items: [bookingView(booking)] } };
    },
    async propose_booking(session, a) { return stage(session, 'booking', await prepareBooking(session, a), a); },
    async propose_cancellation(session, a) { return stage(session, 'cancellation', await prepareCancellation(session, a), a); },
    async propose_support_ticket(session, a) { return stage(session, 'ticket', await prepareTicket(session, a), a); },
  };

  const bookingView = (b) => ({ ref: b.ref, status: b.status, payment_status: b.paymentStatus, vehicle: b.vehicleName, pickup_date: b.pickupDate,
    return_date: b.returnDate, pickup_location: b.pickupLocation, drop_location: b.dropLocation, total_rent: b.totalRent });

  async function runTool(session, name, args) {
    const fn = impl[name];
    if (!fn) return fail('unknown_tool');
    try { return await fn(session, args && typeof args === 'object' ? args : {}); }
    catch (e) { console.error(`[tool ${name}]`, e.message); return fail('backend_error', { message: 'The data source returned an error. Do not retry more than once; tell the customer something went wrong.' }); }
  }

  // ---------- confirm / reject: called by the HTTP layer, never by the LLM ----------
  async function confirm(session, actionId) {
    const p = session.pending;
    if (!p || p.id !== actionId) return { ok: false, error: 'no_matching_pending_action', message: 'That request is no longer pending (already handled, replaced or expired).' };
    session.pending = null; // single use: a double-click or replay cannot execute twice
    if (Date.now() > p.expiresAt) return { ok: false, error: 'expired', message: 'This confirmation expired. Please ask again.' };
    return serial(async () => {
      try {
        const prepared = await PREPARE[p.type](session, p.rawArgs); // fresh re-validation at write time
        if (!prepared.ok) return { ok: false, error: prepared.error, message: `Could not complete: ${humanError(prepared)}` };
        const n = prepared.normalized;
        if (p.type === 'booking') {
          const b = await repo.createBooking(n);
          return { ok: true, message: `Booking ${b.ref} created for ${b.vehicleName} (${b.pickupDate} → ${b.returnDate}), total ${money(b.totalRent)}. Status: ${b.status} - our team will confirm it shortly.`, card: { type: 'bookings', title: 'Booking created', items: [bookingView(b)] }, record: b };
        }
        if (p.type === 'cancellation') {
          const b = await repo.cancelBooking(n.bookingId);
          return { ok: true, message: `Booking ${b.ref} is now ${b.status}.`, card: { type: 'bookings', title: 'Booking cancelled', items: [bookingView(b)] }, record: b };
        }
        const t = await repo.createTicket(n);
        return { ok: true, message: `Support ticket ${t.ref} created (${t.issueType}, ${t.priority} priority, status ${t.status}) for booking ${t.bookingRef}.${t.descriptionStored ? '' : ' Note: your free-text description was not stored in Salesforce.'}`, record: t };
      } catch (e) {
        console.error('[confirm]', e.message);
        return { ok: false, error: 'backend_error', message: 'The action failed in the data source and was NOT completed. Please try again later.' };
      }
    });
  }
  function reject(session, actionId) {
    if (session.pending && session.pending.id === actionId) { session.pending = null; return { ok: true }; }
    return { ok: false };
  }
  return { definitions: TOOL_DEFS, runTool, confirm, reject };
}

export function humanError(r) {
  const m = {
    vehicle_already_booked_for_these_dates: 'that vehicle is already booked for those dates.',
    duplicate_or_overlapping_booking_by_this_customer: `you already have an overlapping booking for this vehicle${r.existing_booking ? ` (${r.existing_booking})` : ''}.`,
    booking_not_cancellable: `this booking is ${r.current_status} and cannot be cancelled.`,
    trip_already_started: 'the trip has already started.',
    similar_open_ticket_exists: `a similar ticket is already open${r.existing_ticket ? ` (${r.existing_ticket})` : ''}.`,
    booking_not_found_for_this_customer: 'no such booking on your account.',
    vehicle_unavailable: 'the vehicle is not available.',
    pickup_date_in_past: 'the pickup date is in the past.',
    customer_not_identified: 'please identify yourself first.',
  };
  return m[r.error] || r.error.replace(/_/g, ' ');
}
