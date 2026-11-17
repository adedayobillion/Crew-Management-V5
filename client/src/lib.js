export const cn = (...a) => a.filter(Boolean).join(' ');
export const naira = n => '₦' + Number(n).toLocaleString('en-NG');
export async function http(url, opts = {}) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
export const postJSON = (url, body, method = 'POST') => http(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
