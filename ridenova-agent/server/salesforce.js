// Minimal Salesforce REST client + repository. Runs ONLY on the backend; credentials never reach the browser.
import { API_VERSION, ENUMS } from './schema.js';
import { soqlStr, soqlList, isSfId } from './util.js';

export class SalesforceError extends Error {
  constructor(message, status) { super(message); this.name = 'SalesforceError'; this.status = status; }
}

export class SalesforceClient {
  constructor(sfConfig, fetchImpl = fetch) {
    this.cfg = sfConfig;
    this.fetch = fetchImpl;
    this.instanceUrl = sfConfig.instanceUrl || '';
    this.token = sfConfig.accessToken || '';
  }
  async authenticate() {
    if (!this.cfg.clientId) { if (!this.token) throw new SalesforceError('No Salesforce credentials configured'); return; }
    const res = await this.fetch(`${this.cfg.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    }).catch(() => { throw new SalesforceError(`Cannot reach Salesforce login at ${this.cfg.loginUrl} - check SF_LOGIN_URL`); });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new SalesforceError(`Salesforce login failed: ${body.error_description || body.error || res.status}`, res.status);
    this.token = body.access_token;
    this.instanceUrl = body.instance_url;
  }
  async request(method, path, body, retried = false) {
    if (!this.token) await this.authenticate();
    const res = await this.fetch(`${this.instanceUrl}/services/data/v${API_VERSION}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => { throw new SalesforceError(`Cannot reach Salesforce at ${this.instanceUrl || '(no SF_INSTANCE_URL)'} - check the URL and your network`); });
    if (res.status === 401 && !retried && this.cfg.clientId) { this.token = ''; return this.request(method, path, body, true); }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = Array.isArray(data) ? data.map((d) => d.message).join('; ') : (data?.message || `HTTP ${res.status}`);
      throw new SalesforceError(res.status === 401 ? 'Salesforce session expired or invalid (refresh SF_ACCESS_TOKEN)' : msg, res.status);
    }
    return data;
  }
  async query(soql) { return (await this.request('GET', `/query?q=${encodeURIComponent(soql)}`)).records; }
  async create(sobject, fields) {
    const r = await this.request('POST', `/sobjects/${sobject}`, fields);
    if (!r?.success) throw new SalesforceError(`Create ${sobject} did not report success`);
    return r.id;
  }
  async update(sobject, id, fields) { await this.request('PATCH', `/sobjects/${sobject}/${id}`, fields); }
}

const VEHICLE_FIELDS = 'Id, Name, Vehicle_Code__c, Brand__c, Model__c, Vehicle_Type__c, Fuel_Type__c, Transmission__c, Seating_Capacity__c, Daily_Rent__c, Security_Deposit__c, Availability_Status__c, Insurance_Expiry_Date__c, RC_Expiry_Date__c, Manufacturing_Year__c, Color__c';
const BOOKING_FIELDS = 'Id, Name, Booking_Status__c, Payment_Status__c, Vehicle__c, Vehicle__r.Name, Vehicle__r.Brand__c, Vehicle__r.Model__c, Customer__c, Customer__r.Name, Booking_Date__c, Pickup_Date__c, Return_Date__c, Pickup_Location__c, Drop_Location__c, Total_Rent__c';
const TICKET_FIELDS = 'Id, Name, Ticket_Status__c, Priority__c, Issue_Type__c, Ticket_Date__c, Assigned_To__c, Booking__c, Booking__r.Name, Customer__c, Customer__r.Name';

const mapVehicle = (r) => ({
  id: r.Id, name: r.Name, code: r.Vehicle_Code__c, brand: r.Brand__c, model: r.Model__c, type: r.Vehicle_Type__c,
  fuel: r.Fuel_Type__c, transmission: r.Transmission__c, seats: r.Seating_Capacity__c, dailyRent: r.Daily_Rent__c,
  securityDeposit: r.Security_Deposit__c, status: r.Availability_Status__c, insuranceExpiry: r.Insurance_Expiry_Date__c,
  rcExpiry: r.RC_Expiry_Date__c, year: r.Manufacturing_Year__c, color: r.Color__c,
});
const mapBooking = (r) => ({
  id: r.Id, ref: r.Name, status: r.Booking_Status__c, paymentStatus: r.Payment_Status__c, vehicleId: r.Vehicle__c,
  vehicleName: [r.Vehicle__r?.Brand__c, r.Vehicle__r?.Model__c].filter(Boolean).join(' ') || r.Vehicle__r?.Name || null,
  customerId: r.Customer__c, customerName: r.Customer__r?.Name ?? null, bookingDate: r.Booking_Date__c,
  pickupDate: r.Pickup_Date__c, returnDate: r.Return_Date__c, pickupLocation: r.Pickup_Location__c,
  dropLocation: r.Drop_Location__c, totalRent: r.Total_Rent__c,
});
const mapTicket = (r) => ({
  id: r.Id, ref: r.Name, status: r.Ticket_Status__c, priority: r.Priority__c, issueType: r.Issue_Type__c,
  ticketDate: r.Ticket_Date__c, assignedTo: r.Assigned_To__c, bookingId: r.Booking__c, bookingRef: r.Booking__r?.Name ?? null,
  customerId: r.Customer__c, customerName: r.Customer__r?.Name ?? null,
});

export class SalesforceRepo {
  constructor(client, sfConfig) { this.sf = client; this.cfg = sfConfig; this.label = 'Salesforce'; }

  async health() { await this.sf.query('SELECT Id FROM Vehicle__c LIMIT 1'); }

  async findContactsByEmail(email) {
    const rows = await this.sf.query(`SELECT Id, Name FROM Contact WHERE Email = ${soqlStr(email)} LIMIT 2`);
    return rows.map((r) => ({ id: r.Id, name: r.Name }));
  }

  async searchVehicles(f) {
    const w = [`Availability_Status__c NOT IN ${soqlList(ENUMS.vehicleBlockedStatuses)}`];
    if (f.type) w.push(`Vehicle_Type__c = ${soqlStr(f.type)}`);
    if (f.brand) w.push(`Brand__c = ${soqlStr(f.brand)}`);
    if (f.fuel) w.push(`Fuel_Type__c = ${soqlStr(f.fuel)}`);
    if (f.transmission) w.push(`Transmission__c = ${soqlStr(f.transmission)}`);
    if (f.minSeats) w.push(`Seating_Capacity__c >= ${Number(f.minSeats)}`);
    if (f.maxDailyRent) w.push(`Daily_Rent__c <= ${Number(f.maxDailyRent)}`);
    const rows = await this.sf.query(`SELECT ${VEHICLE_FIELDS} FROM Vehicle__c WHERE ${w.join(' AND ')} ORDER BY Daily_Rent__c ASC LIMIT 25`);
    return rows.map(mapVehicle);
  }

  async getVehicle(id) {
    if (!isSfId(id)) return null;
    const rows = await this.sf.query(`SELECT ${VEHICLE_FIELDS} FROM Vehicle__c WHERE Id = ${soqlStr(id)} LIMIT 1`);
    return rows[0] ? mapVehicle(rows[0]) : null;
  }

  /** Pending/Confirmed bookings on any of the vehicles that touch [start, end] (inclusive). */
  async findActiveBookingsOverlapping(vehicleIds, start, end) {
    const ids = vehicleIds.filter(isSfId);
    if (!ids.length) return [];
    const rows = await this.sf.query(
      `SELECT ${BOOKING_FIELDS} FROM Booking__c WHERE Vehicle__c IN ${soqlList(ids)} AND Booking_Status__c IN ${soqlList(ENUMS.bookingActiveStatuses)} AND Pickup_Date__c <= ${end} AND Return_Date__c >= ${start} LIMIT 200`);
    return rows.map(mapBooking);
  }

  async listBookingsForCustomer(customerId) {
    if (!isSfId(customerId)) return [];
    const rows = await this.sf.query(`SELECT ${BOOKING_FIELDS} FROM Booking__c WHERE Customer__c = ${soqlStr(customerId)} ORDER BY Pickup_Date__c DESC LIMIT 20`);
    return rows.map(mapBooking);
  }

  async getBookingByRef(ref) {
    const rows = await this.sf.query(`SELECT ${BOOKING_FIELDS} FROM Booking__c WHERE Name = ${soqlStr(ref)} LIMIT 1`);
    return rows[0] ? mapBooking(rows[0]) : null;
  }
  async getBookingById(id) {
    if (!isSfId(id)) return null;
    const rows = await this.sf.query(`SELECT ${BOOKING_FIELDS} FROM Booking__c WHERE Id = ${soqlStr(id)} LIMIT 1`);
    return rows[0] ? mapBooking(rows[0]) : null;
  }

  async createBooking(b) {
    const id = await this.sf.create('Booking__c', {
      Customer__c: b.customerId, Vehicle__c: b.vehicleId, Booking_Date__c: b.bookingDate, Pickup_Date__c: b.pickupDate,
      Return_Date__c: b.returnDate, Pickup_Location__c: b.pickupLocation, Drop_Location__c: b.dropLocation,
      Total_Rent__c: b.totalRent, Security_Deposit__c: b.securityDeposit ?? null,
      Booking_Status__c: 'Pending', Payment_Status__c: 'Pending',
    });
    return this.getBookingById(id);
  }
  async cancelBooking(id) {
    await this.sf.update('Booking__c', id, { Booking_Status__c: 'Cancelled' });
    return this.getBookingById(id);
  }

  async createTicket(t) {
    const fields = {
      Customer__c: t.customerId, Booking__c: t.bookingId, Issue_Type__c: t.issueType, Priority__c: t.priority,
      Ticket_Date__c: t.ticketDate, Ticket_Status__c: 'Open',
    };
    let descriptionStored = false;
    if (this.cfg.ticketDescriptionField && t.description) { fields[this.cfg.ticketDescriptionField] = t.description; descriptionStored = true; }
    const id = await this.sf.create('Support_Ticket__c', fields);
    const rows = await this.sf.query(`SELECT ${TICKET_FIELDS} FROM Support_Ticket__c WHERE Id = ${soqlStr(id)} LIMIT 1`);
    return { ...mapTicket(rows[0]), descriptionStored };
  }
  get ticketDescriptionEnabled() { return !!this.cfg.ticketDescriptionField; }

  async findOpenTickets(bookingId, issueType) {
    if (!isSfId(bookingId)) return [];
    const rows = await this.sf.query(`SELECT ${TICKET_FIELDS} FROM Support_Ticket__c WHERE Booking__c = ${soqlStr(bookingId)} AND Issue_Type__c = ${soqlStr(issueType)} AND Ticket_Status__c IN ${soqlList(ENUMS.ticketOpenStatuses)} LIMIT 5`);
    return rows.map(mapTicket);
  }
  async listPendingBookings() {
    return (await this.sf.query(`SELECT ${BOOKING_FIELDS} FROM Booking__c WHERE Booking_Status__c = 'Pending' ORDER BY Pickup_Date__c ASC LIMIT 100`)).map(mapBooking);
  }
  async listOpenTickets() {
    return (await this.sf.query(`SELECT ${TICKET_FIELDS} FROM Support_Ticket__c WHERE Ticket_Status__c IN ${soqlList(ENUMS.ticketOpenStatuses)} ORDER BY Ticket_Date__c ASC LIMIT 100`)).map(mapTicket);
  }
}
