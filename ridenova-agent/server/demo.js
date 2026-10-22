// DEMO MODE ONLY. In-memory sample data - NOT from Salesforce. Dates are relative to today so the demo always looks current.
import { addDays, daysBetween } from './util.js';
import { ENUMS } from './schema.js';

export class DemoRepo {
  constructor(today) {
    this.label = 'Demo data (not Salesforce)';
    this.seq = { bkg: 7, tkt: 5 };
    const d = (n) => addDays(today, n);
    this.contacts = [
      { id: '003DEMO00000000001', name: 'Aarav Sharma', email: 'aarav@example.com' },
      { id: '003DEMO00000000002', name: 'Priya Nair', email: 'priya@example.com' },
      { id: '003DEMO00000000003', name: 'Rohan Mehta', email: 'rohan@example.com' },
    ];
    const v = (n, o) => ({ id: `a00DEMO000000000${String(n).padStart(2, '0')}`, code: `V-${String(n).padStart(4, '0')}`, color: 'White', ...o });
    this.vehicles = [
      v(1, { brand: 'Maruti', model: 'Swift', type: 'Car', fuel: 'Petrol', transmission: 'Manual', seats: 5, dailyRent: 1800, securityDeposit: 5000, status: 'Available', year: 2022, insuranceExpiry: d(200), rcExpiry: d(900) }),
      v(2, { brand: 'Hyundai', model: 'Creta', type: 'SUV', fuel: 'Diesel', transmission: 'Automatic', seats: 5, dailyRent: 3200, securityDeposit: 10000, status: 'Available', year: 2023, insuranceExpiry: d(150), rcExpiry: d(1000) }),
      v(3, { brand: 'Toyota', model: 'Innova Crysta', type: 'Van', fuel: 'Diesel', transmission: 'Manual', seats: 7, dailyRent: 4200, securityDeposit: 12000, status: 'Booked', year: 2021, insuranceExpiry: d(90), rcExpiry: d(700) }),
      v(4, { brand: 'Honda', model: 'City', type: 'Car', fuel: 'Petrol', transmission: 'Automatic', seats: 5, dailyRent: 2600, securityDeposit: 8000, status: 'Available', year: 2022, insuranceExpiry: d(120), rcExpiry: d(800) }),
      v(5, { brand: 'Tata', model: 'Nexon EV', type: 'SUV', fuel: 'Electric', transmission: 'Automatic', seats: 5, dailyRent: 3000, securityDeposit: 10000, status: 'Available', year: 2024, insuranceExpiry: d(300), rcExpiry: d(1200) }),
      v(6, { brand: 'Mahindra', model: 'Thar', type: 'SUV', fuel: 'Diesel', transmission: 'Manual', seats: 4, dailyRent: 3500, securityDeposit: 12000, status: 'Under Maintenance', year: 2022, insuranceExpiry: d(60), rcExpiry: d(600) }),
      v(7, { brand: 'Kia', model: 'Seltos', type: 'SUV', fuel: 'Petrol', transmission: 'Automatic', seats: 5, dailyRent: 3100, securityDeposit: 10000, status: 'Available', year: 2023, insuranceExpiry: d(180), rcExpiry: d(950) }),
      v(8, { brand: 'Honda', model: 'Activa 6G', type: 'Bike', fuel: 'Petrol', transmission: 'Automatic', seats: 2, dailyRent: 500, securityDeposit: 2000, status: 'Available', year: 2023, insuranceExpiry: d(250), rcExpiry: d(1100) }),
      v(9, { brand: 'Maruti', model: 'Ertiga', type: 'Van', fuel: 'CNG', transmission: 'Manual', seats: 7, dailyRent: 2900, securityDeposit: 9000, status: 'Available', year: 2022, insuranceExpiry: d(140), rcExpiry: d(850) }),
      v(10, { brand: 'MG', model: 'Hector', type: 'SUV', fuel: 'Hybrid', transmission: 'Automatic', seats: 5, dailyRent: 3800, securityDeposit: 12000, status: 'Out of Service', year: 2021, insuranceExpiry: d(40), rcExpiry: d(500) }),
    ];
    const b = (n, o) => ({ id: `a01DEMO000000000${String(n).padStart(2, '0')}`, ref: `BKG-${String(n).padStart(5, '0')}`, paymentStatus: 'Pending', pickupLocation: 'Airport', dropLocation: 'Airport', ...o });
    this.bookings = [
      b(1, { status: 'Confirmed', vehicleId: this.vehicles[2].id, customerId: this.contacts[0].id, bookingDate: d(-6), pickupDate: d(1), returnDate: d(6), totalRent: 21000, paymentStatus: 'Partially Paid' }),
      b(2, { status: 'Pending', vehicleId: this.vehicles[1].id, customerId: this.contacts[1].id, bookingDate: d(-4), pickupDate: d(3), returnDate: d(5), totalRent: 6400 }),
      b(3, { status: 'Pending', vehicleId: this.vehicles[3].id, customerId: this.contacts[2].id, bookingDate: d(-1), pickupDate: d(10), returnDate: d(12), totalRent: 5200 }),
      b(4, { status: 'Completed', vehicleId: this.vehicles[0].id, customerId: this.contacts[0].id, bookingDate: d(-30), pickupDate: d(-25), returnDate: d(-22), totalRent: 5400, paymentStatus: 'Paid' }),
      b(5, { status: 'Cancelled', vehicleId: this.vehicles[4].id, customerId: this.contacts[1].id, bookingDate: d(-12), pickupDate: d(-8), returnDate: d(-6), totalRent: 6000 }),
      b(6, { status: 'Pending', vehicleId: this.vehicles[6].id, customerId: this.contacts[0].id, bookingDate: d(-3), pickupDate: d(14), returnDate: d(17), totalRent: 9300 }),
    ].map((x) => this.#hydrate(x));
    const t = (n, o) => ({ id: `a02DEMO000000000${String(n).padStart(2, '0')}`, ref: `TKT-${String(n).padStart(4, '0')}`, assignedTo: null, ...o });
    this.tickets = [
      t(1, { status: 'Open', priority: 'High', issueType: 'Payment Issue', bookingId: this.bookings[0].id, bookingRef: 'BKG-00001', customerId: this.contacts[0].id, customerName: 'Aarav Sharma', ticketDate: d(-2) }),
      t(2, { status: 'In Progress', priority: 'Critical', issueType: 'Vehicle Breakdown', bookingId: this.bookings[0].id, bookingRef: 'BKG-00001', customerId: this.contacts[0].id, customerName: 'Aarav Sharma', ticketDate: d(-1), assignedTo: 'Support Team A' }),
      t(3, { status: 'Open', priority: 'Low', issueType: 'Other', bookingId: this.bookings[3].id, bookingRef: 'BKG-00004', customerId: this.contacts[0].id, customerName: 'Aarav Sharma', ticketDate: d(-5) }),
      t(4, { status: 'Closed', priority: 'Medium', issueType: 'Refund Request', bookingId: this.bookings[4].id, bookingRef: 'BKG-00005', customerId: this.contacts[1].id, customerName: 'Priya Nair', ticketDate: d(-9) }),
    ];
    this.today = today;
  }
  #hydrate(b) {
    const veh = this.vehicles.find((x) => x.id === b.vehicleId);
    const c = this.contacts.find((x) => x.id === b.customerId);
    return { ...b, vehicleName: veh ? `${veh.brand} ${veh.model}` : null, customerName: c?.name ?? null };
  }
  async health() {}
  async findContactsByEmail(email) { return this.contacts.filter((c) => c.email === email.toLowerCase()).map(({ id, name }) => ({ id, name })); }
  async searchVehicles(f) {
    return this.vehicles.filter((v) => !ENUMS.vehicleBlockedStatuses.includes(v.status)
      && (!f.type || v.type === f.type) && (!f.brand || v.brand === f.brand) && (!f.fuel || v.fuel === f.fuel)
      && (!f.transmission || v.transmission === f.transmission) && (!f.minSeats || v.seats >= f.minSeats)
      && (!f.maxDailyRent || v.dailyRent <= f.maxDailyRent)).sort((a, b) => a.dailyRent - b.dailyRent).slice(0, 25).map((v) => ({ ...v }));
  }
  async getVehicle(id) { const v = this.vehicles.find((x) => x.id === id); return v ? { ...v } : null; }
  async findActiveBookingsOverlapping(ids, start, end) {
    return this.bookings.filter((b) => ids.includes(b.vehicleId) && ENUMS.bookingActiveStatuses.includes(b.status) && b.pickupDate <= end && b.returnDate >= start).map((b) => ({ ...b }));
  }
  async listBookingsForCustomer(cid) { return this.bookings.filter((b) => b.customerId === cid).sort((a, b) => (a.pickupDate < b.pickupDate ? 1 : -1)).map((b) => ({ ...b })); }
  async getBookingByRef(ref) { const b = this.bookings.find((x) => x.ref === ref); return b ? { ...b } : null; }
  async getBookingById(id) { const b = this.bookings.find((x) => x.id === id); return b ? { ...b } : null; }
  async createBooking(x) {
    const n = this.seq.bkg++;
    const b = this.#hydrate({ id: `a01DEMO000000000${String(n).padStart(2, '0')}`, ref: `BKG-${String(n).padStart(5, '0')}`, status: 'Pending', paymentStatus: 'Pending', ...x });
    this.bookings.push(b);
    return { ...b };
  }
  async cancelBooking(id) { const b = this.bookings.find((x) => x.id === id); b.status = 'Cancelled'; return { ...b }; }
  get ticketDescriptionEnabled() { return false; }
  async createTicket(x) {
    const n = this.seq.tkt++;
    const bk = this.bookings.find((b) => b.id === x.bookingId);
    const t = { id: `a02DEMO000000000${String(n).padStart(2, '0')}`, ref: `TKT-${String(n).padStart(4, '0')}`, status: 'Open', priority: x.priority, issueType: x.issueType,
      ticketDate: x.ticketDate, assignedTo: null, bookingId: x.bookingId, bookingRef: bk?.ref, customerId: x.customerId, customerName: this.contacts.find((c) => c.id === x.customerId)?.name, descriptionStored: false };
    this.tickets.push(t);
    return { ...t };
  }
  async findOpenTickets(bookingId, issueType) { return this.tickets.filter((t) => t.bookingId === bookingId && t.issueType === issueType && ENUMS.ticketOpenStatuses.includes(t.status)).map((t) => ({ ...t })); }
  async listPendingBookings() { return this.bookings.filter((b) => b.status === 'Pending').sort((a, b) => (a.pickupDate < b.pickupDate ? -1 : 1)).map((b) => ({ ...b })); }
  async listOpenTickets() { return this.tickets.filter((t) => ENUMS.ticketOpenStatuses.includes(t.status)).map((t) => ({ ...t })); }
}
export { daysBetween };
