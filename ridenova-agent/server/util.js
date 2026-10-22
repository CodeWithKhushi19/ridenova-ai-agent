const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIn(tz = 'Asia/Kolkata', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
export function addDays(s, n) {
  return new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
/** Inclusive overlap: same-day handover counts as a clash (conservative). */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}
export function soqlStr(v) {
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
export function soqlList(arr) { return '(' + arr.map(soqlStr).join(',') + ')'; }
export const isSfId = (s) => typeof s === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s);
export const isEmail = (s) => typeof s === 'string' && s.length <= 120 && /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(s);
export const normBookingRef = (s) => (typeof s === 'string' ? s.trim().toUpperCase() : '');
export const isBookingRef = (s) => /^BKG-\d{1,10}$/.test(s);
export const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');
