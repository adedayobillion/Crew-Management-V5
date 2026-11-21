export const cn = (...a) => a.filter(Boolean).join(' ');
export const naira = n => '₦' + Number(n).toLocaleString('en-NG');
export async function http(url, opts = {}) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
export const postJSON = (url, body, method = 'POST') => http(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Display-only quote. The server recomputes every price; this just previews it.
export const todayLagos = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
export const UNIT_LABEL = { day: 'per day', hour: 'per hour', project: 'flat fee' };
export function quote(unit, start, end, dailyRate, qty) {
  let days = unit === 'half' ? 0.5 : 1;
  if (unit === 'hour') days = Math.max(0, Number(qty) || 0);
  else if (unit === 'project') days = 1;
  else if (unit !== 'half' && start && end) days = Math.max(1, Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1);
  const base = Math.round(Number(dailyRate || 0) * days), fee = Math.round(base * 0.1);
  return { days, base, fee, clientTotal: base + fee, crewNet: base - fee };
}
// Builds the API body for a booking request or offer from the form state.
export function proposalBody(f, rateUnit) {
  if (rateUnit === 'hour') return { bookingUnit: 'hour', startDate: f.start, endDate: f.start, quantity: Number(f.qty) };
  if (rateUnit === 'project') return f.kind === 'delivery' ? { bookingUnit: 'project', scheduleKind: 'delivery', deliveryDate: f.start, startDate: f.start, endDate: f.start } : { bookingUnit: 'project', scheduleKind: 'calendar', startDate: f.start, endDate: f.end || f.start };
  return { bookingUnit: f.unit, startDate: f.start, endDate: f.unit === 'half' ? f.start : (f.end || f.start) };
}
