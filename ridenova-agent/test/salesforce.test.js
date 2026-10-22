// Tests the REST client + repository against a FAKE fetch (no network). They verify request shapes and field names;
// they cannot prove a live org accepts them - do the manual live check in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SalesforceClient, SalesforceRepo } from '../server/salesforce.js';
import { soqlStr } from '../server/util.js';

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url); const call = { method: opts.method || 'GET', path: u.pathname, q: u.searchParams.get('q'), body: opts.body ? (opts.headers['content-type']?.includes('json') ? JSON.parse(opts.body) : opts.body.toString()) : null, auth: opts.headers?.authorization };
    calls.push(call);
    const r = await handler(call);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  f.calls = calls; return f;
}
const cfg = { instanceUrl: 'https://x.my.salesforce.com', accessToken: 'TOKEN123' };

test('soqlStr escapes quotes and backslashes', () => {
  assert.equal(soqlStr("O'Brien\\x"), "'O\\'Brien\\\\x'");
});
test('vehicle search builds a filtered SOQL with only verified fields and maps results', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { records: [{ Id: 'a00xx0000000001AAA', Name: 'Swift', Brand__c: 'Maruti', Model__c: 'Swift', Vehicle_Type__c: 'Car', Daily_Rent__c: 1800, Seating_Capacity__c: 5, Availability_Status__c: 'Available' }] } }));
  const repo = new SalesforceRepo(new SalesforceClient(cfg, f), cfg);
  const v = await repo.searchVehicles({ type: 'Car', fuel: "Petrol' OR Name!='", minSeats: 4 });
  assert.equal(f.calls[0].auth, 'Bearer TOKEN123');
  assert.match(f.calls[0].path, /\/services\/data\/v65\.0\/query$/);
  assert.match(f.calls[0].q, /Availability_Status__c NOT IN \('Under Maintenance','Out of Service'\)/);
  assert.match(f.calls[0].q, /Vehicle_Type__c = 'Car'/);
  assert.match(f.calls[0].q, /Fuel_Type__c = 'Petrol\\' OR Name!=\\''/, 'injection attempt stays inside the string literal');
  assert.match(f.calls[0].q, /Seating_Capacity__c >= 4/);
  assert.equal(v[0].dailyRent, 1800); assert.equal(v[0].brand, 'Maruti');
});
test('createBooking posts verified fields as Pending/Pending, then re-reads the record', async () => {
  const f = fakeFetch((c) => c.method === 'POST' ? { status: 201, body: { id: 'a01xx0000000009AAA', success: true } }
    : { status: 200, body: { records: [{ Id: 'a01xx0000000009AAA', Name: 'BKG-00009', Booking_Status__c: 'Pending', Vehicle__r: { Brand__c: 'Maruti', Model__c: 'Swift' }, Customer__r: { Name: 'A' } }] } });
  const repo = new SalesforceRepo(new SalesforceClient(cfg, f), cfg);
  const b = await repo.createBooking({ customerId: 'c', vehicleId: 'v', bookingDate: '2026-10-11', pickupDate: '2026-10-20', returnDate: '2026-10-22', pickupLocation: 'A', dropLocation: 'B', totalRent: 3600, securityDeposit: 5000 });
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/services/data/v65.0/sobjects/Booking__c');
  assert.deepEqual(Object.keys(post.body).sort(), ['Booking_Date__c', 'Booking_Status__c', 'Customer__c', 'Drop_Location__c', 'Payment_Status__c', 'Pickup_Date__c', 'Pickup_Location__c', 'Return_Date__c', 'Security_Deposit__c', 'Total_Rent__c', 'Vehicle__c']);
  assert.equal(post.body.Booking_Status__c, 'Pending');
  assert.equal(b.ref, 'BKG-00009'); assert.equal(b.vehicleName, 'Maruti Swift');
});
test('cancelBooking PATCHes only the status; ticket description field is only written when configured', async () => {
  const f = fakeFetch((c) => c.method === 'PATCH' ? { status: 204 } : c.method === 'POST' ? { status: 201, body: { id: 'a02xx0000000001AAA', success: true } } : { status: 200, body: { records: [{ Id: 'a02xx0000000001AAA', Name: 'TKT-1', Ticket_Status__c: 'Open', Booking__r: { Name: 'BKG-1' } }] } });
  const repo = new SalesforceRepo(new SalesforceClient(cfg, f), cfg);
  await repo.cancelBooking('a01xx0000000009AAA');
  const patch = f.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { Booking_Status__c: 'Cancelled' });
  const t1 = await repo.createTicket({ customerId: 'c', bookingId: 'b', issueType: 'Other', priority: 'Low', ticketDate: '2026-10-11', description: 'text' });
  assert.equal(t1.descriptionStored, false);
  assert.ok(!('Issue_Description__c' in f.calls.find((c) => c.method === 'POST').body));
  const cfg2 = { ...cfg, ticketDescriptionField: 'Issue_Description__c' };
  const f2 = fakeFetch((c) => c.method === 'POST' ? { status: 201, body: { id: 'a02xx0000000001AAA', success: true } } : { status: 200, body: { records: [{ Id: 'x', Name: 'T' }] } });
  const t2 = await new SalesforceRepo(new SalesforceClient(cfg2, f2), cfg2).createTicket({ customerId: 'c', bookingId: 'b', issueType: 'Other', priority: 'Low', ticketDate: '2026-10-11', description: 'text' });
  assert.equal(f2.calls.find((c) => c.method === 'POST').body.Issue_Description__c, 'text'); assert.equal(t2.descriptionStored, true);
});
test('Salesforce errors surface readable messages; failed create is not treated as success', async () => {
  const f = fakeFetch(() => ({ status: 400, body: [{ message: 'Pickup Date cannot be earlier than Booking Date.', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }] }));
  const repo = new SalesforceRepo(new SalesforceClient(cfg, f), cfg);
  await assert.rejects(() => repo.cancelBooking('a01xx0000000009AAA'), /Pickup Date cannot be earlier/);
  const f2 = fakeFetch(() => ({ status: 201, body: { id: null, success: false } }));
  await assert.rejects(() => new SalesforceClient(cfg, f2).create('Booking__c', {}), /did not report success/);
});
test('client-credentials login, token never in URL, and one retry after 401', async () => {
  let tokens = 0;
  const f = fakeFetch((c) => {
    if (c.path.endsWith('/oauth2/token')) { tokens++; return { status: 200, body: { access_token: `T${tokens}`, instance_url: 'https://x.my.salesforce.com' } }; }
    return c.auth === 'Bearer T1' ? { status: 401, body: [{ message: 'expired' }] } : { status: 200, body: { records: [] } };
  });
  const client = new SalesforceClient({ loginUrl: 'https://x.my.salesforce.com', clientId: 'id', clientSecret: 'sec' }, f);
  assert.deepEqual(await client.query('SELECT Id FROM Vehicle__c'), []);
  assert.equal(tokens, 2);
  assert.ok(f.calls.filter((c) => c.path.includes('/query')).every((c) => !String(c.q).includes('T1')));
  assert.match(f.calls[0].body, /grant_type=client_credentials/);
});
