import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AnimatedNumber, Button, SlidingTabs, inputCls } from './ui.jsx';
import { cn } from './lib.js';

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

export default function Admin() {
  const [token, setToken] = useState(''); const [authed, setAuthed] = useState(false);
  const [tokenInput, setTokenInput] = useState(''); const [loginErr, setLoginErr] = useState('');
  const [tab, setTab] = useState('accounts'); const [msg, setMsg] = useState({ text: '', err: false });
  const [stats, setStats] = useState(null); const [users, setUsers] = useState(null);
  const [filters, setFilters] = useState({ status: 'all', flag: 'all', q: '' });
  const [audit, setAudit] = useState(null); const [bookings, setBookings] = useState(null); const [apps, setApps] = useState(null);
  const [notes, setNotes] = useState({});
  const say = (text, err = false) => setMsg({ text, err });

  const api = useCallback(async (url, opts = {}, t = token) => {
    const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'x-admin-token': t, ...opts.headers } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || `Request failed (${r.status})`);
    return d;
  }, [token]);

  const loadOverview = async (t) => { const d = await api('/api/admin/overview', {}, t); setStats(d.stats); };
  const loadUsers = async (t, f = filters) => { try { const d = await api('/api/admin/users?' + new URLSearchParams({ status: f.status, filter: f.flag, q: f.q.trim() }), {}, t); setUsers(d.users); setNotes(Object.fromEntries(d.users.map(u => [u.id, u.admin_notes || '']))); } catch (e) { say(e.message, true); } };
  const loadAudit = async () => { try { setAudit((await api('/api/admin/audit-log')).events); } catch (e) { say(e.message, true); } };
  const loadBookings = async () => { try { setBookings((await api('/api/admin/bookings')).bookings); } catch (e) { say(e.message, true); } };
  const loadApps = async () => { try { setApps((await api('/api/admin/applications')).applications); } catch (e) { say(e.message, true); } };
  const refreshAll = async t => { await Promise.all([loadOverview(t), loadUsers(t)]); say('Dashboard refreshed.'); };

  async function login(e) {
    e.preventDefault(); const t = tokenInput.trim(); setLoginErr('');
    try { await api('/api/admin/overview', {}, t); setToken(t); setAuthed(true); await Promise.all([loadOverview(t), loadUsers(t)]); }
    catch (err) { setLoginErr(err.message === 'Unauthorized' ? 'Token not accepted. Check CMA_ADMIN_TOKEN in Railway.' : err.message); }
  }
  function lock() { setToken(''); setTokenInput(''); setAuthed(false); setStats(null); setUsers(null); }
  useEffect(() => { if (!authed) return; if (tab === 'audit') loadAudit(); if (tab === 'bookings') loadBookings(); if (tab === 'applications') loadApps(); }, [tab, authed]);

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
        <div className="font-display text-xl font-extrabold tracking-[-.04em]">CMA <small className="block text-[11px] tracking-[.08em] text-muted">ADMIN CONTROL CENTRE</small></div>
        <div className="flex items-center gap-3 text-sm"><a href="/" className="hover:underline">View marketplace ↗</a>{authed && <Button size="sm" variant="dark" onClick={lock}>Lock console</Button>}</div>
      </header>

      <AnimatePresence mode="wait">
        {!authed ? (
          <motion.form key="login" onSubmit={login} initial={{ opacity: 0, y: 22, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }} transition={{ type: 'spring', stiffness: 300, damping: 24 }} className={cn(card, 'mx-auto mt-[9vh] max-w-[480px] p-6 shadow-[0_30px_80px_#14203322]')}>
            <h1 className="font-display text-2xl font-extrabold">Administrator sign-in</h1>
            <p className="mt-2 text-muted">Enter the secret admin token configured in Railway Variables. This token is never embedded in the public marketplace.</p>
            <label htmlFor="token" className="mb-1.5 mt-4 block font-bold">Admin token</label>
            <input id="token" type="password" autoComplete="current-password" required minLength={20} placeholder="Paste CMA_ADMIN_TOKEN" className={inputCls} value={tokenInput} onChange={e => setTokenInput(e.target.value)} />
            <Button variant="dark" type="submit" className="mt-3.5 w-full">Unlock dashboard</Button>
            {loginErr && <div className="mt-3 font-bold text-[#b42318]">{loginErr}</div>}
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
            <SlidingTabs id="adminTabs" value={tab} onChange={setTab} className="my-4 w-fit max-w-full overflow-x-auto" tabs={[{ value: 'accounts', label: 'Accounts' }, { value: 'audit', label: 'Admin activity log' }, { value: 'bookings', label: 'Bookings' }, { value: 'applications', label: 'Crew applications' }]} />
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
                {tab === 'bookings' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Booking requests</h2><Act onClick={loadBookings}>Refresh</Act></div>
                  <div className={cn(card, 'mt-3 p-0')}>{bookings && <Table headers={['Reference', 'Client', 'Crew', 'Project', 'Dates', 'Total', 'Status', 'Payment', 'Overtime agreed', 'Actions']} rows={bookings.map(b => [b.reference, <>{b.client_name}<br />{b.client_email}</>, <>{b.professional_name}<br />{b.professional_role}</>, b.project_type, String(b.start_date).slice(0, 10) + ' – ' + String(b.end_date).slice(0, 10), '₦' + Number(b.client_total).toLocaleString(), b.status, b.payment_status, b.overtime_agreed ? 'Yes' : 'No', <span className="flex gap-1.5"><Act onClick={() => bookingStatus(b.reference)}>Set status</Act><Act cls={soft} onClick={() => bookingOvertime(b.reference, !b.overtime_agreed)}>{b.overtime_agreed ? 'Unmark overtime' : 'Mark overtime agreed'}</Act></span>])} />}</div>
                </>)}
                {tab === 'applications' && (<>
                  <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Crew applications</h2><Act onClick={loadApps}>Refresh</Act></div>
                  <div className={cn(card, 'mt-3 p-0')}>{apps && <Table headers={['Name', 'Email', 'Role', 'Location', 'Portfolio', 'Status', 'Application', 'Actions']} rows={apps.map(a => [a.full_name, a.email, a.role, a.location, a.portfolio_url ? <a className="underline" rel="noopener noreferrer" target="_blank" href={a.portfolio_url}>Open portfolio ↗</a> : '—', a.status, a.bio, <span className="flex gap-1.5"><Act onClick={() => appAct(a.id, 'approved')}>Approve</Act><Act cls={soft} onClick={() => appAct(a.id, 'rejected')}>Reject</Act><Act cls={soft} onClick={() => makeProfile(a.id)}>Create profile</Act></span>])} />}</div>
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
