import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AnimatedNumber, Button, SlidingTabs, inputCls } from './ui.jsx';
import { cn } from './lib.js';
import { ArrowUpRight } from 'lucide-react';

const date = v => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(); };
const pillCls = { approved: 'bg-[#e4f8c7] text-[#365314]', verified: 'bg-[#e4f8c7] text-[#365314]', pending: 'bg-[#fff1d6] text-[#92400e]', suspicious: 'bg-[#fff1d6] text-[#92400e]', rejected: 'bg-[#fee4e2] text-[#b42318]', suspended: 'bg-[#fee4e2] text-[#b42318]', plain: 'bg-[#edf1f5]' };
const Pill = ({ k = 'plain', children }) => <motion.span whileHover={{ scale: 1.06 }} className={cn('rounded-full px-2 py-1 text-[11px] font-extrabold', pillCls[k])}>{children}</motion.span>;
const card = 'rounded-[18px] border border-line bg-white p-[18px] shadow-[0_1px_2px_#1420330a]';

function Table({ headers, rows }) {
  if (!rows.length) return <div className="p-7 text-center text-muted">Nothing to show yet.</div>;
  return (
    <div className="overflow-auto"><table className="w-full border-collapse bg-white text-xs">
      <thead><tr>{headers.map(h => <th key={h} className="whitespace-nowrap border-b border-line bg-[#f8fafc] p-[11px] text-left">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="transition-colors hover:bg-[#fafcf5]">{r.map((v, j) => <td key={j} className="border-b border-line p-[11px] align-top">{v}</td>)}</tr>)}</tbody>
    </table></div>
  );
}


function DisputesPanel({ disputes, reload, api, say }) {
  const btn = 'rounded-[9px] bg-ink px-3 py-2 text-xs font-bold text-white disabled:opacity-50';
  const [open, setOpen] = useState(null); // { dispute, messages }
  const [asking, setAsking] = useState(null); // dispute awaiting a reason
  const [reason, setReason] = useState(''); const [text, setText] = useState(''); const [outcome, setOutcome] = useState('dismiss'); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const money = n => '₦' + Number(n || 0).toLocaleString('en-NG');
  async function openChat() {
    setBusy(true);
    try { setOpen(await api(`/api/admin/disputes/${asking.id}/open`, { method: 'POST', body: JSON.stringify({ reason }) })); setAsking(null); setReason(''); } catch (e) { say(e.message, true); } finally { setBusy(false); }
  }
  async function refreshChat() { const r = await api(`/api/admin/disputes/${open.dispute.id}/open`, { method: 'POST', body: JSON.stringify({ reason: 'Refreshing an open dispute chat' }) }); setOpen(r); }
  async function send(e) {
    e.preventDefault(); if (!text.trim()) return; setBusy(true);
    try { await api(`/api/admin/disputes/${open.dispute.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }); setText(''); await refreshChat(); say('Message sent to both parties.'); } catch (e2) { say(e2.message, true); } finally { setBusy(false); }
  }
  async function resolve(e) {
    e.preventDefault();
    if (!confirm('Resolve this dispute and tell both parties your decision? This cannot be undone.')) return;
    setBusy(true);
    try { const r = await api(`/api/admin/disputes/${open.dispute.id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome, note }) }); say(r.refund_reminder || 'Dispute resolved.'); setOpen(null); setNote(''); await reload(); } catch (e2) { say(e2.message, true); } finally { setBusy(false); }
  }
  if (open) {
    const d = open.dispute, isOpen = d.status === 'open';
    return (<>
      <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Dispute {d.reference}</h2><button type="button" className={btn} onClick={() => { setOpen(null); reload(); }}>Back to list</button></div>
      <div className={cn(card, 'mt-3 grid gap-1 text-sm')}>
        <p><strong>{d.client_name}</strong> booked <strong>{d.crew_name}</strong> · {String(d.start_date).slice(0, 10)}{String(d.end_date).slice(0, 10) !== String(d.start_date).slice(0, 10) ? ' to ' + String(d.end_date).slice(0, 10) : ''}</p>
        <p>Client paid: <strong>{money(d.client_total)}</strong> · Crew payout: <strong>{money(d.crew_net)}</strong> · Payment: <strong>{d.payment_status}</strong> · Booking: <strong>{d.booking_status}</strong></p>
        <p className="text-muted">Reported by the {d.raised_by}: “{d.reason}”</p>
        {!isOpen && <p className="mt-1 rounded-lg bg-[#f1f5f0] p-2">Resolved by {d.resolved_by}: {d.resolution}</p>}
      </div>
      <div className={cn(card, 'mt-3 max-h-[420px] space-y-2 overflow-y-auto bg-[#f7f9f6]')}>
        {open.messages.map(m => m.sender_type === 'admin'
          ? <div key={m.id} className="rounded-xl border border-lime-deep/40 bg-lime-soft p-2.5 text-sm"><b className="text-[11px] uppercase text-[#4d6b14]">Support team</b><p className="whitespace-pre-wrap break-words">{m.masked_content}</p></div>
          : m.kind === 'system' ? <p key={m.id} className="text-center text-[11px] text-muted">{m.masked_content}</p>
          : <div key={m.id} className="text-sm"><span className="text-[11px] text-muted">{m.sender_name} ({m.sender_type}) · {new Date(m.created_at).toLocaleString('en-NG')}</span><p className="whitespace-pre-wrap break-words rounded-xl bg-white p-2.5">{m.masked_content}{m.offer ? ' [offer: ' + money(m.offer.client_total) + ' client / ' + money(m.offer.crew_net) + ' crew]' : ''}</p></div>)}
      </div>
      {isOpen && <>
        <form onSubmit={send} className="mt-3 grid gap-2"><textarea className={inputCls} rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="Write to both parties as the Support team…" /><div><button className={btn} type="submit" disabled={busy || !text.trim()}>Send to both parties</button></div></form>
        <form onSubmit={resolve} className={cn(card, 'mt-3 grid gap-2')}>
          <strong className="text-sm">Resolve this dispute</strong>
          <select className={inputCls} value={outcome} onChange={e => setOutcome(e.target.value)}>
            <option value="dismiss">No change: the booking continues</option>
            <option value="pay_crew">Pay the crew member (mark completed)</option>
            <option value="refund_client">Refund the client (mark refunded)</option>
          </select>
          <textarea className={inputCls} rows={3} maxLength={1000} required value={note} onChange={e => setNote(e.target.value)} placeholder="Your decision, shown to both parties" />
          <div><button className={btn} type="submit" disabled={busy || note.trim().length < 10}>Resolve and notify both</button></div>
        </form>
      </>}
    </>);
  }
  return (<>
    <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Disputes</h2><button type="button" className={btn} onClick={reload}>Refresh</button></div>
    <p className="mt-1 text-xs text-muted">Chats open only through a dispute, with a reason that is saved in the admin activity log.</p>
    <div className={cn(card, 'mt-3 p-0')}>{disputes && <Table headers={['Reference', 'Client', 'Crew', 'Reported by', 'Reason', 'Status', 'Action']} rows={disputes.map(d => [d.reference, d.client_name, d.crew_name, d.raised_by, String(d.reason || '').slice(0, 60), d.status, <button key={d.id} type="button" className={btn} onClick={() => setAsking(d)}>{d.status === 'open' ? 'Review chat' : 'View'}</button>])} />}{disputes && !disputes.length && <p className="p-4 text-sm text-muted">No disputes right now.</p>}</div>
    {asking && (
      <div className={cn(card, 'mt-3 grid gap-2')}>
        <strong className="text-sm">Why are you opening {asking.reference}?</strong>
        <input className={inputCls} value={reason} maxLength={300} onChange={e => setReason(e.target.value)} placeholder="e.g. Client reported crew did not deliver; reviewing the agreement" />
        <div className="flex gap-2"><button type="button" className={btn} disabled={busy || reason.trim().length < 10} onClick={openChat}>Open chat</button><button type="button" className={btn} onClick={() => { setAsking(null); setReason(''); }}>Cancel</button></div>
      </div>)}
  </>);
}

export default function Admin() {
  const [token, setToken] = useState(''); const [authed, setAuthed] = useState(false);
  const [tokenInput, setTokenInput] = useState(''); const [loginErr, setLoginErr] = useState('');
  const [tab, setTab] = useState('accounts'); const [msg, setMsg] = useState({ text: '', err: false });
  const [stats, setStats] = useState(null); const [users, setUsers] = useState(null);
  const [filters, setFilters] = useState({ status: 'all', flag: 'all', q: '' });
  const [disputes, setDisputes] = useState(null); const [audit, setAudit] = useState(null); const [bookings, setBookings] = useState(null); const [apps, setApps] = useState(null); const [listings, setListings] = useState(null); const [idDocuments, setIdDocuments] = useState(null);
  const [notes, setNotes] = useState({});
  const [payouts, setPayouts] = useState(null); const [pros, setPros] = useState(null); const [admins, setAdmins] = useState(null);
  const [adminName, setAdminName] = useState(''); const [cfg, setCfg] = useState({ accounts: false, tokenLogin: true });
  const [useToken, setUseToken] = useState(false);
  const [step, setStep] = useState('creds'); const [creds, setCreds] = useState({ email: '', password: '', code: '' });
  const [ticket, setTicket] = useState(''); const [setup, setSetup] = useState(null); const [recovery, setRecovery] = useState(null);
  const [newAdmin, setNewAdmin] = useState({ name: '', email: '', password: '' });
  const say = (text, err = false) => setMsg({ text, err });

  const api = useCallback(async (url, opts = {}, t = token) => {
    const h = { 'Content-Type': 'application/json', 'x-requested-with': 'cma-admin', ...opts.headers };
    if (t) h['x-admin-token'] = t;
    const r = await fetch(url, { ...opts, credentials: 'same-origin', headers: h });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || `Request failed (${r.status})`);
    return d;
  }, [token]);

  const loadOverview = async (t) => { const d = await api('/api/admin/overview', {}, t); setStats(d.stats); };
  const loadUsers = async (t, f = filters) => { try { const d = await api('/api/admin/users?' + new URLSearchParams({ status: f.status, filter: f.flag, q: f.q.trim() }), {}, t); setUsers(d.users); setNotes(Object.fromEntries(d.users.map(u => [u.id, u.admin_notes || '']))); } catch (e) { say(e.message, true); } };
  const loadAudit = async () => { try { setAudit((await api('/api/admin/audit-log')).events); } catch (e) { say(e.message, true); } };
  const loadDisputes = async () => { try { setDisputes((await api('/api/admin/disputes')).disputes); } catch (e) { say(e.message, true); } };
  const loadBookings = async () => { try { setBookings((await api('/api/admin/bookings')).bookings); } catch (e) { say(e.message, true); } };
  const loadApps = async () => { try { setApps((await api('/api/admin/applications')).applications); } catch (e) { say(e.message, true); } };
  const loadListings = async () => { try { setListings((await api('/api/admin/listings')).listings); } catch (e) { say(e.message, true); } };
  async function removeListing(id, name, role) {
    if (!confirm('Remove ' + name + ' — ' + role + ' from the public marketplace? The account and booking history will remain.')) return;
    try { await api('/api/admin/listings/' + id, { method: 'DELETE' }); say('Listing removed from marketplace.'); await loadListings(); } catch (e) { say(e.message, true); }
  }
  async function restoreListing(id, name) {
    if (!confirm('Restore ' + name + ' to the public marketplace? Photos and portfolio items removed with the listing are not recovered.')) return;
    try { await api('/api/admin/listings/' + id + '/restore', { method: 'POST' }); say('Listing restored.'); await loadListings(); } catch (e) { say(e.message, true); }
  }
  const loadPayouts = async () => { try { setPayouts(await api('/api/admin/payouts')); } catch (e) { say(e.message, true); } };
  const loadPros = async () => { try { setPros((await api('/api/admin/professionals')).professionals); } catch (e) { say(e.message, true); } };
  const loadAdmins = async () => { try { setAdmins((await api('/api/admin/accounts')).accounts); } catch (e) { say(e.message, true); } };
  async function recordPayout(b) {
    if (!confirm('Record a payout of ₦' + Number(b.crew_net).toLocaleString() + ' to ' + b.professional_name + ' for ' + b.reference + '?\n\nOnly do this after you have actually sent the money. The crew member is emailed.')) return;
    try { await api('/api/admin/payouts', { method: 'POST', body: JSON.stringify({ booking_id: b.id }) }); say('Payout recorded.'); loadPayouts(); } catch (e) { say(e.message, true); }
  }
  async function setVerified(p, verified) {
    if (!confirm((verified ? 'Mark ' : 'Remove the verified badge from ') + p.name + (verified ? ' as a verified professional?' : '?'))) return;
    try { await api('/api/admin/verify-professional/' + p.id, { method: 'POST', body: JSON.stringify({ verified }) }); say('Updated.'); loadPros(); } catch (e) { say(e.message, true); }
  }
  async function createAdmin(e) {
    e.preventDefault();
    try { await api('/api/admin/accounts', { method: 'POST', body: JSON.stringify(newAdmin) }); say('Admin created. They set up their authenticator app at first sign-in.'); setNewAdmin({ name: '', email: '', password: '' }); loadAdmins(); } catch (err) { say(err.message, true); }
  }
  async function adminChange(a, body, q) {
    if (!confirm(q)) return;
    try { await api('/api/admin/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify(body) }); say('Updated.'); loadAdmins(); } catch (e) { say(e.message, true); }
  }
  const loadIdDocuments = async () => { try { setIdDocuments((await api('/api/admin/id-documents')).documents); } catch (e) { say(e.message, true); } };
  async function downloadIdDocument(id, filename) {
    try {
      const r = await fetch('/api/admin/id-documents/' + id + '/file', { credentials: 'same-origin', headers: token ? { 'x-admin-token': token } : {} });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw Error(d.error || 'Could not retrieve document.'); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename || 'identity-document'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { say(e.message, true); }
  }
  async function reviewIdDocument(id, status) {
    const note = prompt(status === 'approved' ? 'Optional verification note:' : 'Reason for rejecting this document:');
    if (note === null) return;
    try {
      await api('/api/admin/id-documents/' + id + '/review', { method: 'PATCH', body: JSON.stringify({ status, note }) });
      say('Identity document ' + status + '.');
      await loadIdDocuments();
      await loadUsers();
    } catch (e) { say(e.message, true); }
  }
  const refreshAll = async t => { await Promise.all([loadOverview(t), loadUsers(t)]); say('Dashboard refreshed.'); };

  useEffect(() => {
    (async () => {
      try { setCfg(await (await fetch('/api/admin/auth/config')).json()); } catch (e) { /* keep defaults */ }
      try {
        const me = await (await fetch('/api/admin/auth/me', { credentials: 'same-origin' })).json();
        if (me.admin) { setAdminName(me.admin.name); setAuthed(true); await Promise.all([loadOverview(''), loadUsers('')]); }
      } catch (e) { /* not signed in */ }
    })();
  }, []);
  async function tokenLogin(e) {
    e.preventDefault(); const t = tokenInput.trim(); setLoginErr('');
    try { await api('/api/admin/overview', {}, t); setToken(t); setAuthed(true); setAdminName('token'); await Promise.all([loadOverview(t), loadUsers(t)]); }
    catch (err) { setLoginErr(err.message === 'Unauthorized' ? 'Token not accepted. Check CMA_ADMIN_TOKEN in Railway.' : err.message); }
  }
  async function login(e) {
    e.preventDefault(); setLoginErr('');
    try {
      if (step === 'creds') {
        const d = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: creds.email, password: creds.password }) }, '');
        setTicket(d.ticket); setSetup(d.setup); setStep(d.step); setCreds(c => ({ ...c, code: '' }));
      } else {
        const d = await api('/api/admin/auth/verify', { method: 'POST', body: JSON.stringify({ ticket, code: creds.code }) }, '');
        setAdminName(d.admin.name);
        if (d.recovery_codes) { setRecovery(d.recovery_codes); return; } // show once; continue from that screen
        if (d.used_recovery_code) say('You used a recovery code. Ask another admin to reset your two-factor setup if you lost your phone.', true);
        await finishLogin();
      }
    } catch (err) { setLoginErr(err.message); if (/expired|Start again/.test(err.message)) { setStep('creds'); setSetup(null); } }
  }
  async function finishLogin() { setRecovery(null); setAuthed(true); setCreds({ email: '', password: '', code: '' }); setStep('creds'); setSetup(null); await Promise.all([loadOverview(''), loadUsers('')]); }
  async function lock() { if (!token) await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'cma-admin' } }).catch(() => {}); setToken(''); setTokenInput(''); setAdminName(''); setAuthed(false); setStats(null); setUsers(null); }
  useEffect(() => { if (!authed) return; if (tab === 'audit') loadAudit(); if (tab === 'bookings') loadBookings(); if (tab === 'disputes') loadDisputes(); if (tab === 'applications') loadApps(); if (tab === 'listings') loadListings(); if (tab === 'identity') loadIdDocuments(); if (tab === 'payouts') loadPayouts(); if (tab === 'professionals') loadPros(); if (tab === 'admins') loadAdmins(); }, [tab, authed]);

  const labels = { approve: 'approve this account', reject: 'reject this account', verify: 'mark this account verified', unverify: 'remove this verification', flag_suspicious: 'flag this account for suspicious activity', clear_suspicious: 'clear this suspicious-activity flag', suspend: 'suspend this account and revoke its active sessions', reactivate: 'reactivate this account' };
  async function act(id, action) {
    if (!confirm(`Are you sure you want to ${labels[action]}?`)) return;
    try { await api(`/api/admin/users/${id}/action`, { method: 'PATCH', body: JSON.stringify({ action }) }); say('Account updated.'); await refreshAll(); } catch (e) { say(e.message, true); }
  }
  async function saveNotes(id) {
    try { await api(`/api/admin/users/${id}/action`, { method: 'PATCH', body: JSON.stringify({ action: 'save_notes', notes: notes[id] }) }); say('Internal notes saved.'); await loadUsers(); } catch (e) { say(e.message, true); }
  }
  async function bookingStatus(ref) {
    const status = prompt('New status (awaiting_review, awaiting_terms, confirmed, in_progress, completion_review, completed, disputed, cancelled, refunded):'); if (!status) return;
    try { await api(`/api/admin/bookings/${encodeURIComponent(ref)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); say('Booking updated.'); loadBookings(); } catch (e) { say(e.message, true); }
  }
  async function bookingOvertime(ref, agreed) {
    try { await api(`/api/admin/bookings/${encodeURIComponent(ref)}/overtime-agreed`, { method: 'PATCH', body: JSON.stringify({ agreed }) }); say('Overtime flag updated.'); loadBookings(); } catch (e) { say(e.message, true); }
  }
  async function appAct(id, status) {
    if (!confirm('Set this application to ' + status + '?')) return;
    try { await api(`/api/admin/applications/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); say('Application updated.'); loadApps(); } catch (e) { say(e.message, true); }
  }
  async function makeProfile(id) {
    const dailyRate = Number(prompt('Daily rate in NGN (whole naira):')); if (!Number.isSafeInteger(dailyRate) || dailyRate < 1) return;
    const category = prompt('Category (Camera, Production, Editing, Lighting, Sound, Creative):'); if (!category) return;
    try { const d = await api(`/api/admin/applications/${id}/create-profile`, { method: 'POST', body: JSON.stringify({ dailyRate, category }) }); say('Profile #' + d.professional.id + ' created and linked.'); loadApps(); } catch (e) { say(e.message, true); }
  }

  const btn = 'rounded-[9px] bg-ink px-3 py-2 text-xs font-bold text-white';
  const soft = 'rounded-[9px] bg-[#e7ebf0] px-3 py-2 text-xs font-bold text-ink';
  const Act = ({ cls = btn, ...p }) => <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.95 }} className={cls} {...p} />;

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <header className="sticky top-2.5 z-20 mb-6 flex items-center justify-between gap-4 rounded-[18px] border border-white/80 bg-white/75 px-4 py-3 shadow-[0_10px_36px_#14203314] backdrop-blur-xl">
        <div className="font-display text-xl font-extrabold tracking-[-.04em]">EXPRESS CREWS <small className="block text-[11px] tracking-[.08em] text-muted">ADMIN CONTROL CENTRE</small></div>
        <div className="flex items-center gap-3 text-sm"><a href="/" className="hover:underline">View marketplace <ArrowUpRight className="size-4" aria-hidden="true" /></a>{authed && <span className="text-xs text-muted">Signed in as <strong>{adminName || 'admin'}</strong></span>}{authed && <Button size="sm" variant="dark" onClick={lock}>{token ? 'Lock console' : 'Sign out'}</Button>}</div>
      </header>

      <AnimatePresence mode="wait">
        {!authed ? (
          <motion.form key="login" onSubmit={useToken ? tokenLogin : recovery ? (e => { e.preventDefault(); finishLogin(); }) : login} initial={{ opacity: 0, y: 22, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }} transition={{ type: 'spring', stiffness: 300, damping: 24 }} className={cn(card, 'mx-auto mt-[9vh] max-w-[480px] p-6 shadow-[0_30px_80px_#14203322]')}>
            <h1 className="font-display text-2xl font-extrabold">Administrator sign-in</h1>
            {useToken ? (<>
              <p className="mt-2 text-muted">Enter the secret admin token configured in Railway Variables. Use this only to create the first named admin account.</p>
              <label htmlFor="token" className="mb-1.5 mt-4 block font-bold">Admin token</label>
              <input id="token" type="password" autoComplete="current-password" required minLength={20} placeholder="Paste CMA_ADMIN_TOKEN" className={inputCls} value={tokenInput} onChange={e => setTokenInput(e.target.value)} />
              <Button variant="dark" type="submit" className="mt-3.5 w-full">Unlock dashboard</Button>
            </>) : recovery ? (<>
              <p className="mt-2 font-bold text-[#365314]">Two-factor sign-in is on.</p>
              <p className="mt-1 text-muted">Save these one-time recovery codes somewhere safe, such as a password manager. Each works once if you lose your phone. They are shown only now.</p>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[#f3f6f8] p-3 font-mono text-sm">{recovery.map(c => <span key={c}>{c}</span>)}</div>
              <Button variant="dark" type="submit" className="mt-3.5 w-full">I have saved them. Continue</Button>
            </>) : step === 'creds' ? (<>
              <p className="mt-2 text-muted">Sign in with your admin email and password. You will be asked for a code from your authenticator app.</p>
              <label htmlFor="aemail" className="mb-1.5 mt-4 block font-bold">Email</label>
              <input id="aemail" type="email" autoComplete="username" required className={inputCls} value={creds.email} onChange={e => setCreds(c => ({ ...c, email: e.target.value }))} />
              <label htmlFor="apass" className="mb-1.5 mt-3 block font-bold">Password</label>
              <input id="apass" type="password" autoComplete="current-password" required className={inputCls} value={creds.password} onChange={e => setCreds(c => ({ ...c, password: e.target.value }))} />
              <Button variant="dark" type="submit" className="mt-3.5 w-full">Continue</Button>
            </>) : (<>
              {step === 'enroll' && setup && (<div className="mt-3">
                <p className="text-muted">First sign-in: scan this QR code with Google Authenticator, Authy or 1Password, then enter the 6-digit code it shows.</p>
                <img src={setup.qr} alt="Authenticator QR code" width="200" height="200" className="mx-auto my-3 rounded-lg border border-line" />
                <p className="break-all text-center text-[11px] text-muted">Cannot scan? Enter this key: <span className="font-mono">{setup.secret}</span></p>
              </div>)}
              <label htmlFor="acode" className="mb-1.5 mt-4 block font-bold">{step === 'enroll' ? 'Code from the app' : 'Authenticator code (or a recovery code)'}</label>
              <input id="acode" autoComplete="one-time-code" inputMode="text" required autoFocus className={inputCls} value={creds.code} onChange={e => setCreds(c => ({ ...c, code: e.target.value }))} />
              <Button variant="dark" type="submit" className="mt-3.5 w-full">{step === 'enroll' ? 'Turn on and sign in' : 'Sign in'}</Button>
              <button type="button" onClick={() => { setStep('creds'); setSetup(null); setLoginErr(''); }} className="mt-2 w-full text-center text-xs font-bold underline">Start again</button>
            </>)}
            {loginErr && <div role="alert" className="mt-3 font-bold text-[#b42318]">{loginErr}</div>}
            {cfg.tokenLogin && !recovery && <button type="button" onClick={() => { setUseToken(v => !v); setLoginErr(''); }} className="mt-4 w-full text-center text-xs text-muted underline">{useToken ? 'Sign in with email instead' : 'Use the admin access token instead'}</button>}
          </motion.form>
        ) : (
          <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="my-3.5 rounded-[10px] border border-[#f6d99a] bg-[#fff7e6] p-3 text-[#7a4a00]"><strong>Review carefully:</strong> Verification is a manual admin decision, not an automated identity check. Only mark an account verified after you have checked the evidence through your approved process. Treat suspicious flags as a review signal, not proof of wrongdoing.</div>
            {stats && (
              <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {[['Total accounts', stats.total], ['Pending review', stats.pending], ['Verified', stats.verified], ['Suspicious flagged', stats.suspicious], ['Suspended', stats.suspended], ['Crew / clients', `${stats.crew} / ${stats.clients}`]].map(([l, v], i) => (
                  <motion.div key={l} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} whileHover={{ y: -3 }} className={card}>
                    <span className="block text-xs text-muted">{l}</span><strong className="font-display text-[26px]">{typeof v === 'number' ? <AnimatedNumber value={v} /> : v}</strong>
                  </motion.div>
                ))}
              </div>
            )}
            <SlidingTabs id="adminTabs" value={tab} onChange={setTab} className="my-4 w-fit max-w-full overflow-x-auto" tabs={[{ value: 'accounts', label: 'Accounts' }, { value: 'audit', label: 'Admin activity log' }, { value: 'disputes', label: 'Disputes' }, { value: 'bookings', label: 'Bookings' }, { value: 'applications', label: 'Crew applications' }, { value: 'listings', label: 'Marketplace listings' }, { value: 'identity', label: 'ID verification' }, { value: 'payouts', label: 'Payouts' }, { value: 'professionals', label: 'Verified crew' }, { value: 'admins', label: 'Admins' }]} />
            <AnimatePresence mode="wait">
              <motion.section key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                {tab === 'accounts' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Account review queue</h2><Act onClick={() => refreshAll()}>Refresh</Act></div>
                  <form onSubmit={e => { e.preventDefault(); loadUsers(); }} className="my-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_180px_180px_auto]">
                    <input className={cn(inputCls, 'sm:col-span-2 lg:col-span-1')} placeholder="Search name or email…" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} />
                    <select className={inputCls} value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}><option value="all">All approval statuses</option><option value="pending_review">Pending review</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
                    <select className={inputCls} value={filters.flag} onChange={e => setFilters(f => ({ ...f, flag: e.target.value }))}><option value="all">All account flags</option><option value="suspicious">Suspicious flagged</option><option value="suspended">Suspended</option><option value="unverified">Not verified</option></select>
                    <Act type="submit">Search</Act>
                  </form>
                  <div className="grid gap-3">
                    {users === null ? null : !users.length ? <div className={cn(card, 'p-7 text-center text-muted')}>No accounts match these filters.</div> : users.map((u, i) => (
                      <motion.article key={u.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 6) * 0.05 }} whileHover={{ y: -2 }} className={card}>
                        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                          <div><div className="font-display text-[17px] font-extrabold">{u.full_name} <span className="text-xs font-normal text-muted">#{u.id}</span></div><div className="break-words text-xs text-muted">{u.email} · {u.account_type} · Joined {date(u.created_at)}</div></div>
                          <div className="text-xs text-muted">Reviewed {date(u.reviewed_at)}</div>
                        </div>
                        <div className="my-2.5 flex flex-wrap gap-1.5">
                          <Pill k={u.account_status === 'approved' ? 'approved' : u.account_status === 'rejected' ? 'rejected' : 'pending'}>{u.account_status === 'pending_review' ? 'Pending review' : u.account_status === 'approved' ? 'Approved' : 'Rejected'}</Pill>
                          <Pill k={u.is_verified ? 'verified' : 'plain'}>{u.is_verified ? 'Verified' : 'Unverified'}</Pill>
                          {u.is_suspicious && <Pill k="suspicious">Suspicious flag</Pill>}{u.is_suspended && <Pill k="suspended">Suspended</Pill>}
                        </div>
                        <div className="text-xs text-muted">Terms accepted: {u.terms_accepted_at ? 'Yes · ' + date(u.terms_accepted_at) : 'Not recorded'} {u.terms_version ? `(${u.terms_version})` : ''}</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Act onClick={() => act(u.id, 'approve')}>Approve account</Act><Act cls={soft} onClick={() => act(u.id, 'reject')}>Reject account</Act>
                          <Act onClick={() => act(u.id, u.is_verified ? 'unverify' : 'verify')}>{u.is_verified ? 'Remove verification' : 'Mark verified'}</Act>
                          <Act cls={soft} onClick={() => act(u.id, u.is_suspicious ? 'clear_suspicious' : 'flag_suspicious')}>{u.is_suspicious ? 'Clear suspicious flag' : 'Flag suspicious'}</Act>
                          <Act cls={u.is_suspended ? btn : 'rounded-[9px] bg-[#b42318] px-3 py-2 text-xs font-bold text-white'} onClick={() => act(u.id, u.is_suspended ? 'reactivate' : 'suspend')}>{u.is_suspended ? 'Reactivate' : 'Suspend account'}</Act>
                        </div>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row"><textarea className={cn(inputCls, 'min-h-[42px] resize-y')} maxLength={2000} placeholder="Internal admin notes — factual, relevant, and respectful" value={notes[u.id] ?? ''} onChange={e => setNotes(n => ({ ...n, [u.id]: e.target.value }))} /><Act cls={soft} onClick={() => saveNotes(u.id)}>Save notes</Act></div>
                      </motion.article>
                    ))}
                  </div>
                </>)}
                {tab === 'audit' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Admin activity log</h2><Act onClick={loadAudit}>Refresh log</Act></div>
                  <p className="my-2 text-muted">Records account approval, verification, risk flag, suspension, and note changes.</p>
                  <div className={cn(card, 'p-0')}>{audit && <Table headers={['Time', 'Action', 'Account', 'Email', 'IP address']} rows={audit.map(e => [date(e.created_at), e.action + (e.details?.reference ? ' ' + e.details.reference : '') + (e.details?.status ? ' → ' + e.details.status : ''), e.target_name || '#' + e.target_user_id, e.target_email || '', e.ip_address || '—'])} />}</div>
                </>)}
                {tab === 'disputes' && <DisputesPanel disputes={disputes} reload={loadDisputes} api={api} say={say} />}
                {tab === 'bookings' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Booking requests</h2><Act onClick={loadBookings}>Refresh</Act></div>
                  <div className={cn(card, 'mt-3 p-0')}>{bookings && <Table headers={['Reference', 'Client', 'Crew', 'Project', 'Dates', 'Total', 'Status', 'Payment', 'Overtime agreed', 'Actions']} rows={bookings.map(b => [b.reference, <>{b.client_name}<br />{b.client_email}</>, <>{b.professional_name}<br />{b.professional_role}</>, b.project_type, String(b.start_date).slice(0, 10) + ' – ' + String(b.end_date).slice(0, 10), '₦' + Number(b.client_total).toLocaleString(), b.status, b.payment_status, b.overtime_agreed ? 'Yes' : 'No', <span className="flex gap-1.5"><Act onClick={() => bookingStatus(b.reference)}>Set status</Act><Act cls={soft} onClick={() => bookingOvertime(b.reference, !b.overtime_agreed)}>{b.overtime_agreed ? 'Unmark overtime' : 'Mark overtime agreed'}</Act></span>])} />}</div>
                </>)}
                {tab === 'applications' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Crew applications</h2><Act onClick={loadApps}>Refresh</Act></div>
                  <div className={cn(card, 'mt-3 p-0')}>{apps && <Table headers={['Name', 'Email', 'Role', 'Location', 'Portfolio', 'Status', 'Application', 'Actions']} rows={apps.map(a => [a.full_name, a.email, a.role, a.location, a.portfolio_url ? <a className="underline" rel="noopener noreferrer" target="_blank" href={a.portfolio_url}>Open portfolio <ArrowUpRight className="size-4" aria-hidden="true" /></a> : '—', a.status, a.bio, <span className="flex gap-1.5"><Act onClick={() => appAct(a.id, 'approved')}>Approve</Act><Act cls={soft} onClick={() => appAct(a.id, 'rejected')}>Reject</Act><Act cls={soft} onClick={() => makeProfile(a.id)}>Create profile</Act></span>])} />}</div>
                </>)}
                {tab === 'listings' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Marketplace listings</h2><Act onClick={loadListings}>Refresh</Act></div>
                  <p className="my-2 text-xs text-muted">All active crew listings are published automatically after account identity verification. Remove individual listings that do not meet platform standards. This does not delete the account or booking history.</p>
                  <div className={cn(card, 'mt-3 p-0')}>{listings && <Table headers={['Listing', 'Account email', 'Category', 'Location', 'Rate / day', 'Status', 'Actions']} rows={listings.map(p => [<><strong>#{p.id} · {p.name}</strong><br />{p.role}</>, p.email || '—', p.category || '—', p.location || '—', '₦' + Number(p.rate || 0).toLocaleString(), p.status === 'approved' && p.is_active ? <Pill k="approved">Published</Pill> : <Pill k="rejected">{p.status === 'removed' ? 'Removed' : p.status || 'Inactive'}</Pill>, p.status === 'approved' && p.is_active ? <Act cls="rounded-[9px] bg-[#b42318] px-3 py-2 text-xs font-bold text-white" onClick={() => removeListing(p.id, p.name, p.role)}>Remove listing</Act> : p.status === 'removed' ? <Act cls="rounded-[9px] bg-ink px-3 py-2 text-xs font-bold text-white" onClick={() => restoreListing(p.id, p.name)}>Restore listing</Act> : '—'])} />}</div>
                </>)}
                {tab === 'payouts' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Crew payouts</h2><Act onClick={loadPayouts}>Refresh</Act></div>
                  <p className="my-2 text-xs text-muted">Bookings the client has paid for and confirmed as complete. Send the money to the crew member yourself, then record it here. Recording does not move money.</p>
                  <h3 className="mt-3 font-bold">Waiting to be paid out</h3>
                  <div className={cn(card, 'mt-2 p-0')}>{payouts && <Table headers={['Booking', 'Crew', 'Client', 'Crew receives', 'Completed', 'Action']} rows={payouts.due.map(b => [b.reference, b.professional_name, b.client_name, '₦' + Number(b.crew_net).toLocaleString(), date(b.completed_at), <Act key={b.id} onClick={() => recordPayout(b)}>Record payout</Act>])} />}</div>
                  <h3 className="mt-5 font-bold">Recent payouts</h3>
                  <div className={cn(card, 'mt-2 p-0')}>{payouts && <Table headers={['Reference', 'Booking', 'Crew', 'Amount', 'Recorded']} rows={payouts.paid.map(p => [p.payout_reference, p.reference, p.professional_name, '₦' + Number(p.amount).toLocaleString(), date(p.created_at)])} />}</div>
                </>)}
                {tab === 'professionals' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Verified crew badge</h2><Act onClick={loadPros}>Refresh</Act></div>
                  <p className="my-2 text-xs text-muted">The badge tells clients you have personally checked this professional's work or credentials.</p>
                  <div className={cn(card, 'mt-3 p-0')}>{pros && <Table headers={['Listing', 'Category', 'Rating', 'Status', 'Badge']} rows={pros.map(p => [<><strong>#{p.id} · {p.name}</strong><br />{p.role}</>, p.category || '—', p.review_count ? Number(p.rating).toFixed(1) + ' (' + p.review_count + ')' : 'No reviews', p.is_active ? <Pill k="approved">Live</Pill> : <Pill>Paused</Pill>, p.verified ? <Act key={p.id} cls={soft} onClick={() => setVerified(p, false)}>Remove badge</Act> : <Act key={p.id} onClick={() => setVerified(p, true)}>Mark verified</Act>])} />}</div>
                </>)}
                {tab === 'admins' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Administrator accounts</h2><Act onClick={loadAdmins}>Refresh</Act></div>
                  <p className="my-2 text-xs text-muted">Each admin signs in with their own password and an authenticator-app code, and their name appears in the activity log. Once everyone has an account, set <code>ADMIN_TOKEN_AUTH=disabled</code> in Railway to switch off the shared token.</p>
                  <div className={cn(card, 'mt-3 p-0')}>{admins && <Table headers={['Name', 'Email', 'Two-factor', 'Last sign-in', 'Actions']} rows={admins.map(a => [a.name + (a.disabled ? ' (disabled)' : ''), a.email, a.two_factor ? <Pill k="approved">On</Pill> : <Pill k="pending">Not set up</Pill>, date(a.last_login), <span key={a.id} className="flex gap-2"><Act cls={soft} onClick={() => adminChange(a, { reset_2fa: true }, 'Reset two-factor for ' + a.name + '? They will set it up again at their next sign-in.')}>Reset 2FA</Act><Act cls={soft} onClick={() => adminChange(a, { disabled: !a.disabled }, (a.disabled ? 'Re-enable ' : 'Disable ') + a.name + '?')}>{a.disabled ? 'Enable' : 'Disable'}</Act></span>])} />}</div>
                  <form onSubmit={createAdmin} className={cn(card, 'mt-4 grid gap-3 sm:grid-cols-3')}>
                    <div><label htmlFor="nan" className="mb-1 block font-bold">Name</label><input id="nan" required maxLength={60} className={inputCls} value={newAdmin.name} onChange={e => setNewAdmin(v => ({ ...v, name: e.target.value }))} /></div>
                    <div><label htmlFor="nae" className="mb-1 block font-bold">Email</label><input id="nae" type="email" required className={inputCls} value={newAdmin.email} onChange={e => setNewAdmin(v => ({ ...v, email: e.target.value }))} /></div>
                    <div><label htmlFor="nap" className="mb-1 block font-bold">Temporary password</label><input id="nap" type="password" required minLength={12} autoComplete="new-password" className={inputCls} value={newAdmin.password} onChange={e => setNewAdmin(v => ({ ...v, password: e.target.value }))} /></div>
                    <div className="sm:col-span-3"><Button variant="dark" type="submit">Add administrator</Button><span className="ml-3 text-xs text-muted">12+ characters with a letter and a number. Share it privately.</span></div>
                  </form>
                </>)}
                {tab === 'identity' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Identity document review</h2><Act onClick={loadIdDocuments}>Refresh</Act></div>
                  <p className="my-2 text-xs text-muted">Identity documents are confidential personal data. Retrieve files only when required for verification.</p>
                  <div className={cn(card, 'mt-3 p-0')}>{idDocuments && <Table headers={['Account', 'Document', 'Uploaded', 'Status', 'Review note', 'Actions']} rows={idDocuments.map(d => [<>{d.name}<br /><span className="text-muted">{d.email}</span></>, <>{String(d.document_type).replaceAll('_', ' ')}<br /><span className="text-muted">{d.original_name} · {d.mime_type}</span></>, date(d.created_at), <Pill k={d.review_status === 'approved' ? 'approved' : d.review_status === 'rejected' ? 'rejected' : 'pending'}>{d.review_status}</Pill>, d.review_note || '—', <span className="flex flex-wrap gap-1.5"><Act onClick={() => downloadIdDocument(d.id, d.original_name)}>View / download</Act><Act cls={soft} onClick={() => reviewIdDocument(d.id, 'approved')}>Approve</Act><Act cls={soft} onClick={() => reviewIdDocument(d.id, 'rejected')}>Reject</Act></span>])} />}</div>
                </>)}
              </motion.section>
            </AnimatePresence>
            <div role="status" className={cn('mt-4 font-bold', msg.err ? 'text-[#b42318]' : 'text-[#365314]')}>{msg.text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
