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
export function quote(unit, start, end, dailyRate) {
  let days = unit === 'half' ? 0.5 : 1;
  if (unit !== 'half' && start && end) days = Math.max(1, Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1);
  const base = Math.round(Number(dailyRate || 0) * days), fee = Math.round(base * 0.1);
  return { days, base, fee, clientTotal: base + fee, crewNet: base - fee };
}
