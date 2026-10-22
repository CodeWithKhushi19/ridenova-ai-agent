// Verifies every Salesforce object/field/picklist value the app uses really exists in this project's force-app metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USED_FIELDS, PICKLIST_CHECKS, ENUMS, API_VERSION } from '../server/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const objDir = path.join(root, 'force-app', 'main', 'default', 'objects');
const have = fs.existsSync(objDir);
const skip = have ? false : 'force-app not found next to ridenova-agent/ (run tests from inside the RideNova project)';

test('API version matches sfdx-project.json', { skip }, () => {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8'));
  assert.equal(p.sourceApiVersion, API_VERSION);
});
for (const [obj, fields] of Object.entries(USED_FIELDS)) {
  test(`${obj}: all used fields exist`, { skip }, () => {
    for (const f of fields) assert.ok(fs.existsSync(path.join(objDir, obj, 'fields', `${f}.field-meta.xml`)), `${obj}.${f} not found in metadata`);
  });
}
for (const [obj, map] of Object.entries(PICKLIST_CHECKS)) {
  test(`${obj}: enum values exist in picklists`, { skip }, () => {
    for (const [field, enumKey] of Object.entries(map)) {
      const xml = fs.readFileSync(path.join(objDir, obj, 'fields', `${field}.field-meta.xml`), 'utf8');
      const vals = [...xml.matchAll(/<fullName>([^<]*)<\/fullName>/g)].map((m) => m[1].replace(/&amp;/g, '&')).slice(1);
      for (const v of ENUMS[enumKey]) assert.ok(vals.includes(v), `${obj}.${field} has no value "${v}" (has: ${vals.join(', ')})`);
    }
  });
}
test('status picklists used in logic exist', { skip }, () => {
  const vals = (o, f) => [...fs.readFileSync(path.join(objDir, o, 'fields', `${f}.field-meta.xml`), 'utf8').matchAll(/<fullName>([^<]*)<\/fullName>/g)].map((m) => m[1]).slice(1);
  for (const v of [...ENUMS.vehicleBlockedStatuses, 'Available', 'Booked']) assert.ok(vals('Vehicle__c', 'Availability_Status__c').includes(v), v);
  for (const v of [...ENUMS.bookingActiveStatuses, 'Cancelled']) assert.ok(vals('Booking__c', 'Booking_Status__c').includes(v), v);
  for (const v of [...ENUMS.ticketOpenStatuses, 'Open']) assert.ok(vals('Support_Ticket__c', 'Ticket_Status__c').includes(v), v);
  assert.ok(vals('Booking__c', 'Payment_Status__c').includes('Pending'));
});
test('Booking Name is the BKG-xxxxx auto-number the agent expects', { skip }, () => {
  const xml = fs.readFileSync(path.join(objDir, 'Booking__c', 'Booking__c.object-meta.xml'), 'utf8');
  assert.match(xml, /<displayFormat>BKG-\{0+\}<\/displayFormat>/);
});
