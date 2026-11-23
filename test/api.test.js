'use strict';
// Integration tests: boots the real server against DATABASE_URL (a throwaway database!) with fake Bachs and SendByte servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB) { console.error('Set DATABASE_URL (or TEST_DATABASE_URL) to a throwaway Postgres database.'); process.exit(1); }
if (!/test/i.test(new URL(DB).pathname) && process.env.ALLOW_DB_WIPE !== '1') { console.error('Refusing to wipe a database whose name does not contain "test". Use a throwaway database, or set ALLOW_DB_WIPE=1.'); process.exit(1); }
const PORT = 4100 + Math.floor(Math.random() * 500), BACHS = PORT + 1000, MAIL = PORT + 2000;
const BASE = 'http://localhost:' + PORT, ADMIN_TOKEN = 'test-admin-token-0123456789abcdef', WH = 'whsec_test';
const pool = new Pool({ connectionString: DB });
let server; const fakes = []; const mails = []; const sessions = {};

function fakeServer(port, handler) { return new Promise(r => { const s = http.createServer((q, res) => { let b = ''; q.on('data', d => b += d); q.on('end', () => handler(q, b, (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); })); }).listen(port, () => { fakes.push(s); r(s); }); }); }
function agent() {
  const jar = {};
  const call = async (method, path, body, headers = {}) => {
    const h = { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...headers };
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    let json = null; try { json = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, body: json };
  };
  return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), patch: (p, b, h) => call('PATCH', p, b, h), put: (p, b, h) => call('PUT', p, b, h), del: (p, h) => call('DELETE', p, undefined, h) };
}
function totp(secret) {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of secret) bits += B.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2)));
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(c).digest(), o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const signed = body => { const raw = JSON.stringify(body), t = Math.floor(Date.now() / 1000); return { raw, sig: 't=' + t + ',v1=' + crypto.createHmac('sha256', WH).update(t + '.' + raw).digest('hex') }; };
const register = async (name, type) => { const a = agent(); const r = await a.post('/api/auth/register', { name: /\s/.test(name) ? name : name + ' Tester', phone: '+234 801 234 5678', location: 'Lagos', email: name.toLowerCase().replace(/\W/g, '') + '@test.dev', password: 'password123456', termsAccepted: true, accountType: type }); assert.equal(r.status, 201, JSON.stringify(r.body)); await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [r.body.user.id]); return { a, id: r.body.user.id, email: r.body.user.email }; };
const tomorrow = n => new Date(Date.now() + (n + 20) * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await fakeServer(BACHS, (q, b, send) => {
    if (q.headers.authorization !== 'Bearer sk_test_x') return send(401, {});
    if (q.method === 'POST' && q.url === '/v1/checkout-sessions') { const j = JSON.parse(b), id = 'cs_' + crypto.randomBytes(4).toString('hex'); sessions[id] = { checkout_id: id, status: 'open', amount: Number(j.pricing.amount), currency: 'NGN', reference: j.reference }; return send(200, { checkout_id: id, checkout_url: 'https://pay.test/' + id }); }
    if (q.method === 'GET') { const s = sessions[q.url.split('/').pop()]; return s ? send(200, s) : send(404, {}); }
    send(404, {});
  });
  await fakeServer(MAIL, (q, b, send) => { mails.push(JSON.parse(b)); send(201, { id: 'em' }); });
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'development', CMA_ADMIN_TOKEN: ADMIN_TOKEN, ADMIN_2FA_KEY: 'ab'.repeat(32), PAYMENTS_ENABLED: 'true', BACHS_API_KEY: 'sk_test_x', BACHS_WEBHOOK_SECRET: WH, BACHS_API_BASE: 'http://localhost:' + BACHS, SENDBYTE_API_KEY: 'sk_test_mail', SENDBYTE_API_BASE: 'http://localhost:' + MAIL, MAIL_FROM: 'Crew <noreply@test.dev>', APP_URL: BASE }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch (e) { /* not up yet */ } await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(async () => { server?.kill(); for (const f of fakes) { f.closeAllConnections?.(); f.close(); } await pool.end(); });

test('health, share tags and static assets', async () => {
  assert.equal((await agent().get('/api/health')).status, 200);
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('og:image" content="' + BASE + '/og.png"'));
  assert.equal((await fetch(BASE + '/favicon.svg')).status, 200);
});

test('accounts: password rules, login, wrong password, reset flow, change password, delete', async () => {
  const a = agent();
  const base = { name: 'Ada Obi', phone: '+234 801 234 5678', location: 'Lagos', email: 'req@test.dev', password: 'password123456', termsAccepted: true, accountType: 'client' };
  for (const bad of [{ name: 'Ada' }, { phone: '' }, { phone: 'abc' }, { location: '' }, { email: 'nope' }]) assert.equal((await a.post('/api/auth/register', { ...base, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await a.post('/api/auth/register', { name: 'Weak Tester', phone: '+234 801 234 5678', location: 'Lagos', email: 'weak@test.dev', password: 'short', termsAccepted: true, accountType: 'client' })).status, 400);
  const u = await register('Reset Me', 'client');
  assert.equal((await agent().post('/api/auth/login', { email: u.email, password: 'wrongpassword1' })).status, 401);
  assert.equal((await agent().post('/api/auth/forgot', { email: 'nobody@test.dev' })).status, 200);
  const before = mails.length;
  await agent().post('/api/auth/forgot', { email: u.email }); await new Promise(r => setTimeout(r, 400));
  assert.equal(mails.length, before + 1);
  const token = /reset=([0-9a-f]{64})/.exec(mails[mails.length - 1].text)[1];
  assert.equal((await agent().post('/api/auth/reset', { token, password: 'weak' })).status, 400);
  assert.equal((await agent().post('/api/auth/reset', { token, password: 'brandnewpass123' })).status, 200);
  assert.equal((await agent().post('/api/auth/reset', { token, password: 'anotherpass12345' })).status, 400, 'token is single use');
  assert.equal((await u.a.get('/api/auth/me')).body.user, null, 'old sessions are signed out');
  const again = agent(); assert.equal((await again.post('/api/auth/login', { email: u.email, password: 'brandnewpass123' })).status, 200);
  assert.equal((await again.post('/api/auth/change-password', { current: 'nope', password: 'thirdpassword123' })).status, 403);
  assert.equal((await again.post('/api/auth/change-password', { current: 'brandnewpass123', password: 'thirdpassword123' })).status, 200);
  assert.equal((await again.post('/api/account/delete', { password: 'thirdpassword123' })).status, 200);
  assert.equal((await agent().post('/api/auth/login', { email: u.email, password: 'thirdpassword123' })).status, 401);
});

test('email verification gates bookings', async () => {
  const a = agent(); const r = await a.post('/api/auth/register', { name: 'Unverified Tester', phone: '+234 801 234 5678', location: 'Lagos', email: 'unv@test.dev', password: 'password123456', termsAccepted: true, accountType: 'client' });
  const res = await a.post('/api/bookings', { professionalId: 1, startDate: tomorrow(1), endDate: tomorrow(1), message: 'x' });
  assert.equal(res.status, 403); assert.equal(res.body.code, 'email_unverified');
  await new Promise(r2 => setTimeout(r2, 300));
  const token = /verify=([0-9a-f]{64})/.exec(mails.reverse().find(m => m.to === 'unv@test.dev').text)[1]; mails.reverse();
  assert.equal((await agent().post('/api/auth/verify-email', { token })).status, 200);
  assert.ok(r.body.user.id);
});

let client, crew, listingId, bookingId;
test('crew publishes a listing, edits it, blocks dates; photos are validated', async () => {
  client = await register('Client One', 'client'); crew = await register('Crew One', 'crew');
  assert.equal((await crew.a.post('/api/crew-applications', { role: 'Camera', location: 'Lagos', bio: 'DP', dailyRate: 60000 })).status, 403, 'needs identity verification');
  await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [crew.id]);
  const pub = await crew.a.post('/api/crew-applications', { role: 'Camera', location: 'Lagos', bio: 'DP', dailyRate: 60000 });
  assert.equal(pub.status, 201, JSON.stringify(pub.body)); listingId = pub.body.listing.id;
  assert.equal((await agent().get('/api/professionals')).body.professionals.length, 1);
  assert.equal((await crew.a.patch('/api/crew/listing', { rate: 5 })).status, 400);
  assert.equal((await crew.a.patch('/api/crew/listing', { rate: 70000, skills: 'Drone, Steadicam', showreel: 'https://vimeo.com/1' })).status, 200);
  assert.equal((await crew.a.patch('/api/crew/listing', { showreel: 'http://insecure.example' })).status, 400);
  assert.equal((await client.a.patch('/api/crew/listings/' + listingId, { rate: 1000 })).status, 404, 'others cannot edit');
  const html = Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await crew.a.post('/api/crew/photo', { mime_type: 'image/jpeg', data_base64: html })).status, 400);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]).toString('base64');
  assert.equal((await crew.a.post('/api/crew/photo', { mime_type: 'image/jpeg', data_base64: jpg })).status, 200);
  const blk = await crew.a.post('/api/crew/availability', { start_date: tomorrow(3), end_date: tomorrow(4) }); assert.equal(blk.status, 201);
  assert.equal((await client.a.post('/api/bookings', { professionalId: listingId, startDate: tomorrow(3), endDate: tomorrow(3), message: 'x' })).status, 409, 'blocked dates cannot be booked');
  assert.equal((await crew.a.del('/api/crew/availability/' + blk.body.block.id)).status, 200);
});

test('booking, acceptance, strict cancellation, payment via Bachs webhook, completion', async () => {
  const b = await client.a.post('/api/bookings', { professionalId: listingId, startDate: tomorrow(10), endDate: tomorrow(10), message: 'Shoot day' });
  assert.equal(b.status, 201, JSON.stringify(b.body)); bookingId = b.body.booking.id;
  assert.equal((await client.a.post('/api/payments/initialize', { booking_id: bookingId })).status, 409, 'cannot pay before acceptance');
  const msg = (await pool.query(`SELECT id FROM messages WHERE booking_id = $1 AND kind = 'request'`, [bookingId])).rows[0].id;
  assert.equal((await crew.a.post(`/api/bookings/${bookingId}/offers/${msg}/respond`, { response: 'accepted' })).status, 200);
  assert.equal((await client.a.post(`/api/bookings/${bookingId}/cancel`, {})).status >= 400, true, 'no free cancellation once confirmed');
  await pool.query(`UPDATE users SET phone = '0803 555 0101' WHERE id = $1`, [crew.id]);
  assert.equal((await client.a.get(`/api/bookings/${bookingId}/contact`)).body.available, false, 'no contact details before payment');
  assert.equal((await crew.a.post('/api/payments/initialize', { booking_id: bookingId })).status, 403, 'only the client pays');
  const init = await client.a.post('/api/payments/initialize', { booking_id: bookingId }); assert.equal(init.status, 200, JSON.stringify(init.body));
  const cs = (await pool.query('SELECT checkout_id, gateway_reference FROM payments WHERE booking_id = $1', [bookingId])).rows[0];
  const ev = { type: 'checkout.session.completed', data: { checkout_id: cs.checkout_id, reference: cs.gateway_reference } };
  const post = (raw, sig) => fetch(BASE + '/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bachs-signature-v2': sig }, body: raw });
  const s = signed(ev);
  assert.equal((await post(s.raw, 't=1,v1=' + '0'.repeat(64))).status, 401, 'bad signature');
  assert.equal((await post(s.raw + ' ', s.sig)).status, 401, 'tampered body');
  await post(s.raw, s.sig);
  assert.equal((await pool.query('SELECT payment_status FROM bookings WHERE id = $1', [bookingId])).rows[0].payment_status, 'unpaid', 'unpaid session does not settle');
  Object.assign(sessions[cs.checkout_id], { status: 'completed', charge: { status: 'succeeded' } });
  const ok = await (await post(s.raw, s.sig)).json(); assert.equal(ok.status, 'verified');
  assert.equal((await pool.query('SELECT payment_status FROM bookings WHERE id = $1', [bookingId])).rows[0].payment_status, 'paid');
  await post(s.raw, s.sig);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM invoices WHERE booking_id = $1', [bookingId])).rows[0].n, 1, 'replay is idempotent');
  const cc = await client.a.get(`/api/bookings/${bookingId}/contact`); assert.equal(cc.body.available, true); assert.equal(cc.body.phone, '0803 555 0101', 'client sees crew phone once confirmed');
  assert.equal((await crew.a.get(`/api/bookings/${bookingId}/contact`)).body.available, true);
  const stranger = await register('Stranger', 'client');
  assert.equal((await stranger.a.get(`/api/bookings/${bookingId}/contact`)).status >= 400, true, 'strangers get nothing');
  assert.equal((await client.a.post(`/api/bookings/${bookingId}/complete`, {})).status, 409, 'cannot complete before the job starts');
  await pool.query(`UPDATE bookings SET start_date = CURRENT_DATE - 2, end_date = CURRENT_DATE - 2 WHERE id = $1`, [bookingId]);
  assert.equal((await crew.a.post(`/api/bookings/${bookingId}/complete`, {})).status, 403, 'only the client completes');
  assert.equal((await client.a.post(`/api/bookings/${bookingId}/complete`, {})).status, 200);
  // two-way reviews: crew reviews the booker, and other crew then see it on the client profile
  assert.equal((await client.a.get(`/api/bookings/${bookingId}/client-profile`)).status, 403, 'clients do not see their own profile view');
  assert.equal((await crew.a.post('/api/reviews', { booking_id: bookingId, rating: 5, comment: 'Paid on time, clear brief.' })).status, 201);
  assert.equal((await crew.a.post('/api/reviews', { booking_id: bookingId, rating: 5 })).status, 409, 'one review per side');
  const cp = (await crew.a.get(`/api/bookings/${bookingId}/client-profile`)).body; assert.equal(cp.review_count, 1); assert.equal(cp.completed_jobs >= 1, true); assert.equal(cp.reviews[0].comment, 'Paid on time, clear brief.');
  // portfolio
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString('base64');
  const pf = `/api/crew/listings/${listingId}/portfolio`;
  assert.equal((await client.a.post(pf, { kind: 'link', url: 'https://youtu.be/abc123XYZ_-' })).status, 404, 'only the listing owner can add');
  assert.equal((await crew.a.post(pf, { kind: 'link', url: 'http://evil.example/x' })).status, 400);
  assert.equal((await crew.a.post(pf, { kind: 'link', url: 'https://www.instagram.com/someone' })).status, 400, 'only in-app playable video links');
  assert.equal((await crew.a.post(pf, { kind: 'image', data_base64: Buffer.from('not an image at all').toString('base64') })).status, 400, 'content must be a real image');
  const img = await crew.a.post(pf, { kind: 'image', data_base64: jpg, caption: 'Set photo' }); assert.equal(img.status, 201);
  assert.equal((await crew.a.post(pf, { kind: 'link', url: 'https://youtu.be/abc123XYZ_-' })).status, 201);
  const items = (await agent().get(`/api/professionals/${listingId}/portfolio`)).body; assert.equal(items.length, 2);
  assert.equal((await agent().get(items.find(i => i.kind === 'image').url)).status, 200, 'public can view portfolio images');
  assert.equal((await crew.a.del(`${pf}/${img.body.id}`)).status, 200);
});

test('admin: named account with 2FA, recovery codes, payout rules, audit', async () => {
  const tok = { 'x-admin-token': ADMIN_TOKEN }, csrf = { 'x-requested-with': 'cma-admin' };
  assert.equal((await agent().get('/api/admin/accounts')).status, 401);
  assert.equal((await agent().post('/api/admin/accounts', { name: 'Ada', email: 'ada@test.dev', password: 'adminpassword123' }, tok)).status, 201);
  const a = agent();
  assert.equal((await a.post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'nope' })).status, 401);
  const l = await a.post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'adminpassword123' }); assert.equal(l.body.step, 'enroll');
  assert.equal((await a.post('/api/admin/auth/verify', { ticket: l.body.ticket, code: '000000' })).status, 401);
  const v = await a.post('/api/admin/auth/verify', { ticket: l.body.ticket, code: totp(l.body.setup.secret) });
  assert.equal(v.status, 200); assert.equal(v.body.recovery_codes.length, 8);
  assert.equal((await a.post('/api/admin/accounts', { name: 'Bo', email: 'bo@test.dev', password: 'adminpassword123' })).status, 403, 'cookie sessions need the CSRF header');
  const l2 = await agent().post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'adminpassword123' });
  assert.equal(l2.body.step, 'code');
  const b = agent(); const l3 = await b.post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'adminpassword123' });
  assert.equal((await b.post('/api/admin/auth/verify', { ticket: l3.body.ticket, code: totp(l.body.setup.secret) })).status, 401, 'a used code cannot be replayed');
  const c = agent(); const l4 = await c.post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'adminpassword123' });
  assert.equal((await c.post('/api/admin/auth/verify', { ticket: l4.body.ticket, code: v.body.recovery_codes[0] })).status, 200, 'recovery code works');
  const l5 = await agent().post('/api/admin/auth/login', { email: 'ada@test.dev', password: 'adminpassword123' });
  assert.equal((await agent().post('/api/admin/auth/verify', { ticket: l5.body.ticket, code: v.body.recovery_codes[0] })).status, 401, 'recovery code is single use');
  // payout: the booking above is paid and completed
  const due = await a.get('/api/admin/payouts'); assert.equal(due.body.due.length, 1);
  assert.equal((await a.post('/api/admin/payouts', { booking_id: bookingId }, csrf)).status, 200);
  assert.equal((await a.post('/api/admin/payouts', { booking_id: bookingId }, csrf)).status, 409, 'no double payout');
  assert.equal((await a.post('/api/admin/verify-professional/' + listingId, { verified: false }, csrf)).status, 200);
  const log = (await pool.query(`SELECT action, actor FROM admin_audit_log`)).rows;
  assert.ok(log.some(r => r.action === 'payout_recorded' && r.actor === 'Ada'));
  assert.equal((await a.post('/api/admin/auth/logout', {}, csrf)).status, 200);
  assert.equal((await a.get('/api/admin/accounts')).status, 401);
});

test('group booking creates one linked request per crew member', async () => {
  const crew2 = await register('Crew Two', 'crew'); await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [crew2.id]);
  const l2 = (await crew2.a.post('/api/crew-applications', { role: 'Sound', location: 'Lagos', bio: 'Boom', dailyRate: 30000 })).body.listing.id;
  const d = tomorrow(40), body = { professionalIds: [listingId, l2], title: 'Brand film', startDate: d, endDate: d, message: 'Two day shoot' };
  assert.equal((await client.a.post('/api/group-bookings', { ...body, professionalIds: [listingId] })).status, 400, 'needs 2+');
  assert.equal((await client.a.post('/api/group-bookings', { ...body, title: '' })).status, 400);
  const r = await client.a.post('/api/group-bookings', body);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.bookings.length, 2);
  assert.ok(r.body.bookings.every(b => b.group_ref === r.body.group_ref && b.group_title === 'Brand film' && b.status === 'awaiting_review'));
  // pay for the group in one checkout once members accept
  const [b1, b2] = r.body.bookings; const grp = r.body.group_ref;
  // same person, overlapping dates: no second booking, even under another role
  const again = await client.a.post('/api/bookings', { professionalId: listingId, startDate: d, endDate: d, message: 'again' });
  assert.equal(again.status, 409, 'duplicate booking for the same dates is refused');
  const l3 = (await crew2.a.post('/api/crew/listings', { role: 'Gaffer', category: 'Lighting', location: 'Lagos', rate: 25000, bio: 'Lights' })).body;
  const l3id = l3.listing && l3.listing.id;
  assert.ok(l3id, JSON.stringify(l3)); assert.equal((await client.a.post('/api/group-bookings', { professionalIds: [l2, l3id], title: 'Twice', startDate: d, endDate: d })).status, 409, 'one person cannot be booked under two roles on the same dates');
  // read receipts: the sender's message is "seen" only after the other side marks it read
  const unseen = (await client.a.get(`/api/bookings/${b1.id}/messages`)).body.find(m => m.kind === 'request');
  assert.equal(unseen.read_by_other, false);
  assert.equal((await crew.a.post(`/api/inbox/${b1.id}/read`, {})).status, 200);
  const seenMsg = (await client.a.get(`/api/bookings/${b1.id}/messages`)).body.find(m => m.kind === 'request');
  assert.equal(seenMsg.read_by_other, true);
  // each side only sees its own money
  const cm = (await crew.a.get(`/api/bookings/${b1.id}/messages`)).body, km = (await client.a.get(`/api/bookings/${b1.id}/messages`)).body;
  assert.ok(!JSON.stringify(cm).includes('client_total') && JSON.stringify(cm).includes('crew_net'), 'crew sees payout, not the client total');
  assert.ok(!JSON.stringify(km).includes('crew_net') && JSON.stringify(km).includes('client_total'), 'client sees total, not the payout');
  const ci = (await crew.a.get('/api/inbox')).body.conversations, ki = (await client.a.get('/api/inbox')).body.conversations;
  assert.ok(ci.length && ci.every(x => x.client_total === undefined && x.crew_net !== undefined), 'crew inbox'); assert.ok(ki.length && ki.every(x => x.crew_net === undefined && x.client_total !== undefined), 'client inbox');
  assert.equal((await client.a.post('/api/payments/initialize-group', { group_ref: grp })).status, 409, 'nothing accepted yet');
  const accept = async (who, id) => { const m = (await pool.query(`SELECT id FROM messages WHERE booking_id = $1 AND kind = 'request'`, [id])).rows[0].id; return who.a.post(`/api/bookings/${id}/offers/${m}/respond`, { response: 'accepted' }); };
  assert.equal((await accept(crew, b1.id)).status, 200); assert.equal((await accept(crew2, b2.id)).status, 200);
  assert.equal((await crew.a.post('/api/payments/initialize-group', { group_ref: grp })).status, 404, 'only the client pays');
  const gi = await client.a.post('/api/payments/initialize-group', { group_ref: grp }); assert.equal(gi.status, 200, JSON.stringify(gi.body));
  assert.equal(gi.body.count, 2); assert.equal(gi.body.amount, Number(b1.client_total) + Number(b2.client_total));
  const gp = (await pool.query('SELECT checkout_id, gateway_reference FROM payments WHERE booking_ids IS NOT NULL')).rows[0];
  Object.assign(sessions[gp.checkout_id], { status: 'completed', charge: { status: 'succeeded' } });
  const gev = signed({ type: 'checkout.session.completed', data: { checkout_id: gp.checkout_id, reference: gp.gateway_reference } });
  const gw = await fetch(BASE + '/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bachs-signature-v2': gev.sig }, body: gev.raw });
  assert.equal((await gw.json()).status, 'verified');
  const paidRows = (await pool.query('SELECT payment_status FROM bookings WHERE group_ref = $1', [grp])).rows;
  assert.ok(paidRows.length === 2 && paidRows.every(x => x.payment_status === 'paid'), 'both bookings paid');
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM invoices WHERE booking_id = ANY($1::int[])', [[b1.id, b2.id]])).rows[0].n, 2, 'one invoice each');
  assert.equal((await client.a.post('/api/payments/initialize-group', { group_ref: grp })).status, 409, 'nothing left to pay');
  await pool.query('INSERT INTO availability_blocks (professional_id, start_date, end_date) VALUES ($1,$2,$2)', [l2, tomorrow(41)]);
  const before = (await pool.query('SELECT COUNT(*)::int n FROM bookings')).rows[0].n;
  assert.equal((await client.a.post('/api/group-bookings', { ...body, startDate: tomorrow(41), endDate: tomorrow(41) })).status, 409, 'one unavailable member rejects the group');
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM bookings')).rows[0].n, before, 'nothing partially created');
});

test('hourly and flat-fee listings: quantity, delivery date, calendar blocking', async () => {
  const hr = await register('Hourly Crew', 'crew'); await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [hr.id]);
  const lh = (await hr.a.post('/api/crew/listings', { role: 'Editor', category: 'Editing', location: 'Lagos', rate: 10000, rateUnit: 'hour', bio: 'Edits' })).body.listing;
  const lp = (await hr.a.post('/api/crew/listings', { role: 'Colourist', category: 'Editing', location: 'Lagos', rate: 150000, rateUnit: 'project', bio: 'Grades' })).body.listing;
  assert.equal(lh.rate_unit, 'hour'); assert.equal(lp.rate_unit, 'project');
  const d = tomorrow(60), d2 = tomorrow(63);
  assert.equal((await client.a.post('/api/bookings', { professionalId: lh.id, startDate: d, quantity: 0 })).status, 400, 'hours required');
  const h = await client.a.post('/api/bookings', { professionalId: lh.id, startDate: d, quantity: 3.5, message: 'edit' });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.equal(Number(h.body.booking.client_total), 38500); assert.equal(h.body.booking.crew_net, undefined);
  // either side can propose a new price in chat; the other side accepts and totals are recomputed
  const ho = await client.a.post(`/api/bookings/${h.body.booking.id}/offers`, { startDate: d, quantity: 3.5, dailyRate: 8000, note: 'Agreed 8k in chat' });
  assert.equal(ho.status, 201, JSON.stringify(ho.body));
  const hm = (await pool.query(`SELECT id FROM messages WHERE booking_id = $1 AND kind = 'offer' ORDER BY id DESC LIMIT 1`, [h.body.booking.id])).rows[0].id;
  assert.equal((await client.a.post(`/api/bookings/${h.body.booking.id}/offers/${hm}/respond`, { response: 'accepted' })).status, 403, 'proposer cannot accept their own change');
  assert.equal((await hr.a.post(`/api/bookings/${h.body.booking.id}/offers/${hm}/respond`, { response: 'accepted' })).status, 200);
  const hb = (await pool.query('SELECT client_total, crew_net, daily_rate FROM bookings WHERE id = $1', [h.body.booking.id])).rows[0];
  assert.deepEqual([Number(hb.daily_rate), Number(hb.client_total), Number(hb.crew_net)], [8000, 30800, 25200]);
  const dl = await client.a.post('/api/bookings', { professionalId: lp.id, scheduleKind: 'delivery', deliveryDate: d2, message: 'grade' });
  assert.equal(dl.status, 201, JSON.stringify(dl.body));
  assert.equal(dl.body.booking.schedule_kind, 'delivery'); assert.equal(Number(dl.body.booking.client_total), 165000);
  assert.equal((await client.a.post('/api/bookings', { professionalId: lp.id, scheduleKind: 'delivery', deliveryDate: '2020-01-01' })).status, 400, 'past delivery date');
  // a delivery project does not block the crew calendar when accepted
  const mid = (await pool.query(`SELECT id FROM messages WHERE booking_id = $1 AND kind = 'request'`, [dl.body.booking.id])).rows[0].id;
  assert.equal((await hr.a.post(`/api/bookings/${dl.body.booking.id}/offers/${mid}/respond`, { response: 'accepted' })).status, 200);
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM availability_blocks WHERE professional_id = $1`, [lp.id])).rows[0].n, 0, 'delivery bookings leave the calendar free');
  const cal = await client.a.post('/api/bookings', { professionalId: lp.id, scheduleKind: 'calendar', startDate: tomorrow(70), endDate: tomorrow(72), message: 'on set' });
  assert.equal(cal.status, 201); assert.equal(cal.body.booking.schedule_kind, 'calendar');
  assert.equal((await client.a.post('/api/group-bookings', { professionalIds: [lh.id, listingId], title: 'x', startDate: tomorrow(80), endDate: tomorrow(80) })).status, 400, 'hourly crew cannot join a group');
});

test('hardening: no-store API responses, small JSON bodies, per-account login throttle', async () => {
  const h = await fetch(BASE + '/api/professionals');
  assert.equal(h.headers.get('cache-control'), 'no-store'); assert.ok(h.headers.get('permissions-policy'));
  assert.match(h.headers.get('content-security-policy') || '', /img-src 'self' data: blob: https:\/\/i\.ytimg\.com;/);
  const big = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200000) }) });
  assert.equal(big.status, 413, 'oversized JSON is refused on normal routes');
  const email = `throttle${Date.now()}@test.dev`; let last;
  for (let i = 0; i < 9; i++) last = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong-password-1' }) });
  assert.equal(last.status, 429, 'the account is throttled after repeated failures');
});

test('admin disputes: audited chat review, support messages, resolution', async () => {
  const ADM = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-requested-with': 'cma-admin' };
  const call = (path, method = 'GET', body) => fetch(BASE + path, { method, headers: ADM, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const pay = (await pool.query(`SELECT b.id FROM bookings b WHERE b.status = 'completed' AND b.payment_status = 'paid' ORDER BY b.id DESC LIMIT 1`)).rows[0];
  assert.ok(pay, 'a paid, completed booking exists from the earlier test');
  const d = (await pool.query(`INSERT INTO disputes (booking_id, raised_by, reason, status) VALUES ($1,'client','Crew delivered late and the work was incomplete','open') RETURNING id`, [pay.id])).rows[0];
  await pool.query(`UPDATE bookings SET status = 'disputed' WHERE id = $1`, [pay.id]);
  const list = await call('/api/admin/disputes'); assert.equal(list.status, 200); assert.ok(list.body.disputes.some(x => x.id === d.id));
  assert.equal((await call(`/api/admin/disputes/${d.id}/open`, 'POST', { reason: 'short' })).status, 400, 'a real reason is required');
  const opened = await call(`/api/admin/disputes/${d.id}/open`, 'POST', { reason: 'Reviewing the complaint about late delivery' });
  assert.equal(opened.status, 200); assert.ok(Array.isArray(opened.body.messages) && opened.body.messages.length);
  assert.ok((await pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'chat_viewed'`)).rows.length, 'chat view is audited');
  assert.equal((await call(`/api/admin/disputes/${d.id}/messages`, 'POST', { text: 'We are looking into this and will decide within 24 hours.' })).status, 201);
  const seen = (await client.a.get(`/api/bookings/${pay.id}/messages`)).body;
  assert.ok(seen.some(m => m.sender_type === 'admin' && m.sender_name === 'Support team'), 'the client sees the support message');
  assert.equal((await call(`/api/admin/disputes/${d.id}/resolve`, 'POST', { outcome: 'bogus', note: 'x'.repeat(20) })).status, 400);
  const done = await call(`/api/admin/disputes/${d.id}/resolve`, 'POST', { outcome: 'refund_client', note: 'Refunding the client because the work was not delivered.' });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.ok(done.body.refund_reminder);
  const row = (await pool.query('SELECT status, payment_status FROM bookings WHERE id = $1', [pay.id])).rows[0];
  assert.deepEqual([row.status, row.payment_status], ['refunded', 'refunded']);
  assert.equal((await call(`/api/admin/disputes/${d.id}/resolve`, 'POST', { outcome: 'dismiss', note: 'x'.repeat(20) })).status, 409, 'cannot resolve twice');
});

test('call sheets: create, public view hides phones, owner-only edits, booked crew', async () => {
  const body = { title: 'Brand film day 1', project: 'Brand film', date: tomorrow(30), location: 'Lekki, Lagos', mapUrl: 'javascript:alert(1)', generalCall: '07:00', notes: 'Bring water',
    emergency: [{ name: 'Producer', phone: '0800 111 2222' }], schedule: [{ time: '07:30', item: 'Setup' }, { time: '25:99', item: 'Bad time ignored' }],
    crew: [{ name: 'Ada', role: 'DP', call: '06:30', phone: '0801 000 0000' }, { name: '', role: 'nobody' }], showPhones: false };
  assert.equal((await client.a.post('/api/callsheets', { ...body, title: '' })).status, 400);
  const c = await client.a.post('/api/callsheets', body); assert.equal(c.status, 201, JSON.stringify(c.body));
  const sheet = c.body.sheet; assert.ok(sheet.token.length >= 16);
  assert.equal(sheet.data.mapUrl, '', 'non-http map links are dropped'); assert.equal(sheet.data.crew.length, 1); assert.equal(sheet.data.schedule[1].time, '');
  const pub = await (await fetch(BASE + '/api/public/callsheets/' + sheet.token)).json();
  assert.equal(pub.sheet.title, 'Brand film day 1'); assert.equal(pub.sheet.crew[0].phone, '', 'crew phones hidden by default'); assert.equal(pub.sheet.emergency[0].phone, '0800 111 2222');
  assert.equal((await fetch(BASE + '/api/public/callsheets/doesnotexist')).status, 404);
  assert.equal((await crew.a.put('/api/callsheets/' + sheet.id, body)).status, 404, 'only the owner can edit');
  assert.equal((await crew.a.del('/api/callsheets/' + sheet.id)).status, 404);
  const u = await client.a.put('/api/callsheets/' + sheet.id, { ...body, showPhones: true }); assert.equal(u.status, 200);
  assert.equal((await (await fetch(BASE + '/api/public/callsheets/' + sheet.token)).json()).sheet.crew[0].phone, '0801 000 0000', 'owner can show phones');
  assert.equal((await client.a.get('/api/callsheets')).body.sheets.length >= 1, true);
  assert.equal((await client.a.get('/api/callsheets/booked-crew')).status, 200);
  assert.equal((await client.a.post('/api/callsheets/' + sheet.id + '/notify', {})).status, 400, 'no booked crew to notify');
  assert.equal((await client.a.del('/api/callsheets/' + sheet.id)).status, 200);
  assert.equal((await fetch(BASE + '/api/public/callsheets/' + sheet.token)).status, 404, 'deleted sheets stop working');
});

test('existing accounts without a phone or location are flagged and must complete their profile', async () => {
  const u = await register('Legacy Person', 'client');
  await pool.query('UPDATE users SET phone = NULL, location = NULL WHERE id = $1', [u.id]);
  assert.equal((await u.a.get('/api/profile')).body.user.profileComplete, false);
  assert.equal((await u.a.patch('/api/profile', { name: 'Legacy Person', phone: '', location: 'Lagos' })).status, 400);
  const ok = await u.a.patch('/api/profile', { name: 'Legacy Person', phone: '+234 802 000 1111', location: 'Abuja' });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.profileComplete, true);
});

test('job board: post, apply, owner-only review, accept opens a booking', async () => {
  const job = { title: 'Wedding highlight film', category: 'Camera', role: 'Videographer', description: 'Two-camera coverage of a Lagos wedding, 8 hours on the day.', location: 'Lagos', budget: 150000, startDate: tomorrow(60), endDate: tomorrow(60) };
  assert.equal((await agent().post('/api/jobs', job)).status, 401);
  assert.equal((await client.a.post('/api/jobs', { ...job, description: 'short' })).status, 400);
  assert.equal((await client.a.post('/api/jobs', { ...job, category: 'Nope' })).status, 400);
  const p = await client.a.post('/api/jobs', job); assert.equal(p.status, 201, JSON.stringify(p.body)); const id = p.body.job.id;
  const board = await agent().get('/api/jobs'); assert.ok(board.body.jobs.some(j => j.id === id), 'public board lists open jobs');
  assert.equal(JSON.stringify(board.body).includes('owner'), false, 'no owner details on the public board');
  assert.equal((await client.a.post(`/api/jobs/${id}/apply`, { message: 'I would love to shoot this.' })).status, 400, 'owners cannot apply to their own job');
  assert.equal((await crew.a.post(`/api/jobs/${id}/apply`, { message: 'x' })).status, 400);
  assert.equal((await crew.a.post(`/api/jobs/${id}/apply`, { message: 'I have shot 40 weddings in Lagos.', quote: 140000 })).status, 201);
  assert.equal((await crew.a.post(`/api/jobs/${id}/apply`, { message: 'I have shot 40 weddings in Lagos.' })).status, 409, 'one application per job');
  const mine = await client.a.get('/api/my/jobs'); const app = mine.body.jobs.find(j => j.id === id).applications[0]; assert.equal(app.quote, 140000);
  assert.equal((await crew.a.post(`/api/jobs/${id}/applications/${app.id}/accept`, {})).status, 404, 'only the owner can accept');
  const acc = await client.a.post(`/api/jobs/${id}/applications/${app.id}/accept`, {}); assert.equal(acc.status, 201, JSON.stringify(acc.body));
  assert.ok(acc.body.booking.id, 'accepting opens a booking request');
  assert.equal((await agent().get('/api/jobs')).body.jobs.some(j => j.id === id), false, 'filled jobs leave the board');
});

test('crew can delete a listing, unless it has open bookings', async () => {
  const c = await register('Del Crew', 'crew'); await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [c.id]); const p = await c.a.post('/api/crew/listings', { role: 'Gaffer', category: 'Lighting', location: 'Lagos', rate: 50000, bio: 'Lighting for film sets.', skills: ['LED'] });
  assert.equal(p.status, 201, JSON.stringify(p.body)); const id = p.body.listing.id;
  assert.equal((await client.a.del('/api/crew/listings/' + id)).status >= 400, true, 'only the owner deletes');
  const d = await c.a.del('/api/crew/listings/' + id); assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await c.a.get('/api/crew/listing')).body.listings.some(l => l.id === id), false, 'gone from the crew dashboard');
  assert.equal((await agent().get('/api/professionals')).body.professionals.some(x => x.id === id), false, 'gone from the marketplace');
});
