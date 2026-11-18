import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, Modal, ModalHead, SlidingTabs, Tagline, inputCls, useToast } from './ui.jsx';
import { naira, postJSON } from './lib.js';
import { legalPolicies } from './legal.js';
import { ArrowUpRight } from 'lucide-react';

/* ================= Auth ================= */
export function AuthModal({ open, mode, setMode, defaultRole, onClose, onSuccess, openLegal }) {
  const reg = mode === 'register';
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'client', terms: false });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const first = useRef(null);
  useEffect(() => { if (open) { setErr(''); setF(s => ({ ...s, role: defaultRole || 'client' })); setTimeout(() => first.current?.focus(), 120); } }, [open, mode]);
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    const payload = reg ? { name: f.name, email: f.email, password: f.password, accountType: f.role, termsAccepted: f.terms } : { email: f.email, password: f.password };
    try {
      const { ok, data } = await postJSON('/api/auth/' + mode, payload);
      if (!ok) throw new Error(data.error || 'Could not authenticate.');
      setF({ name: '', email: '', password: '', role: 'client', terms: false });
      onSuccess(data.user, mode);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="authTitle" className="sm:max-w-[470px] sm:p-8">
      <motion.div initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14, delay: 0.1 }}
        className="mb-4 grid size-[46px] place-items-center rounded-[15px] bg-lime font-display text-[22px] font-extrabold shadow-[0_6px_16px_#8ebc4655]">C.</motion.div>
      <ModalHead tag="Your production network" id="authTitle" title={reg ? 'Create your account' : 'Welcome back'} onClose={onClose} />
      <p className="-mt-3 mb-4 text-[13px] text-muted">{reg ? 'One account to hire crew and offer your own services. Switch between Hiring and Crew any time.' : 'Sign in to manage your bookings and your crew profile.'}</p>
      <SlidingTabs id="authTabs" value={mode} onChange={setMode} tabs={[{ value: 'login', label: 'Log in' }, { value: 'register', label: 'Create account' }]} className="mb-4" />
      <form onSubmit={submit} className="grid gap-3.5">
        <AnimatePresence initial={false}>
          {reg && (
            <motion.div key="n" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <Field label="Full name" htmlFor="authName"><input ref={first} id="authName" className={inputCls} required value={f.name} onChange={set('name')} autoComplete="name" maxLength={120} placeholder="Your full name" /></Field>
            </motion.div>
          )}
        </AnimatePresence>
        <Field label="Email address" htmlFor="authEmail"><input ref={reg ? null : first} id="authEmail" type="email" className={inputCls} required value={f.email} onChange={set('email')} autoComplete="email" maxLength={254} placeholder="you@example.com" /></Field>
        <Field label="Password" htmlFor="authPassword"><input id="authPassword" type="password" className={inputCls} required minLength={10} maxLength={200} value={f.password} onChange={set('password')} autoComplete={reg ? 'new-password' : 'current-password'} placeholder={reg ? 'At least 10 characters, with a letter and number' : 'Your password'} /></Field>
        <AnimatePresence initial={false}>
          {reg && (
            <motion.div key="r" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="grid gap-3.5 overflow-hidden">
              <label className="flex items-start gap-2 text-xs font-semibold text-muted">
                <input type="checkbox" required={reg} checked={f.terms} onChange={set('terms')} className="mt-0.5 accent-[#526f1f]" />
                <span>I agree to the <button type="button" className="text-[#526f1f] underline" onClick={() => openLegal('terms')}>Terms of Service</button> and acknowledge the <button type="button" className="text-[#526f1f] underline" onClick={() => openLegal('privacy')}>Privacy Policy</button>.</span>
              </label>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>{err && <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="alert" className="rounded-[10px] border border-[#f6d5d5] bg-[#fff0f0] px-3 py-2.5 text-xs text-[#a13232]">{err}</motion.div>}</AnimatePresence>
        <Button variant="dark" type="submit" disabled={busy} className="w-full">{busy ? (reg ? 'Creating account…' : 'Signing in…') : (reg ? <>Create account securely <ArrowUpRight className="size-4" aria-hidden="true" /></> : <>Log in securely <ArrowUpRight className="size-4" aria-hidden="true" /></>)}</Button>
      </form>
      <p className="mt-4 text-center text-[11px] leading-relaxed text-muted">Your account is protected with a hashed password and a secure, HTTP-only session cookie. Use a unique password for this platform.</p>
    </Modal>
  );
}

/* ================= Booking ================= */
const blankBooking = { projectType: '', unit: 'full', start: '', end: '', location: '', overtime: '', brief: '' };
export function BookingModal({ pro, user, onClose, onSent, onNeedAuth }) {
  const open = !!pro; const [f, setF] = useState(blankBooking); const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (open) setF(blankBooking); }, [pro?.id]);
  const set = k => e => setF(s => {
    const n = { ...s, [k]: e.target.value };
    if (n.unit === 'half') n.end = n.start; else if (n.end && n.start && n.end < n.start) n.end = n.start;
    return n;
  });
  const m = useMemo(() => {
    let days = 1;
    if (f.unit === 'half') days = 0.5;
    else if (f.start && f.end) days = Math.max(1, Math.floor((new Date(f.end + 'T12:00:00') - new Date(f.start + 'T12:00:00')) / 86400000) + 1);
    const base = pro ? Math.round(pro.rate * days) : 0; const clientFee = Math.round(base * 0.1), crewFee = Math.round(base * 0.1);
    return { days, base, clientFee, crewFee, clientTotal: base + clientFee, crewNet: base - crewFee, agencyGross: clientFee + crewFee };
  }, [f.unit, f.start, f.end, pro]);
  async function submit(e) {
    e.preventDefault(); if (!pro) return; setBusy(true);
    try {
      const { ok, status, data } = await postJSON('/api/bookings', { professionalId: pro.id, clientName: user.name, clientEmail: user.email, projectType: f.projectType, bookingUnit: f.unit, startDate: f.start, endDate: f.end, projectLocation: f.location, overtimeTerms: f.overtime, brief: f.brief });
      if (!ok) { if (status === 401) { onNeedAuth(pro); return; } throw new Error(data.error || 'Could not save booking.'); }
      onSent(data.booking);
    } catch (err) { toast(err.message || 'Could not connect to backend.'); } finally { setBusy(false); }
  }
  const row = (a, b, cls = '') => <div className={'flex justify-between gap-4 ' + cls}><span>{a}</span><strong className="text-right">{b}</strong></div>;
  const daysLabel = f.unit === 'half' ? 'half-day (50% of daily rate)' : `${m.days} full day${m.days === 1 ? '' : 's'}`;
  return (
    <Modal open={open} onClose={onClose} labelledBy="bookingTitle">
      <ModalHead tag="Booking request" id="bookingTitle" title={pro ? 'Request ' + pro.role : 'Book a professional'} onClose={onClose} />
      <form onSubmit={submit}>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Your name *" htmlFor="clientName"><input id="clientName" className={inputCls} readOnly value={user?.name || ''} /></Field>
          <Field label="Email *" htmlFor="clientEmail"><input id="clientEmail" className={inputCls} readOnly value={user?.email || ''} /></Field>
          <Field label="Project type *" htmlFor="projectType"><select id="projectType" required className={inputCls} value={f.projectType} onChange={set('projectType')}><option value="">Choose project</option>{['Film / TV', 'Commercial / advert', 'Music video', 'Digital content', 'Documentary', 'Other'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Booking type *" htmlFor="bookingUnit"><select id="bookingUnit" required className={inputCls} value={f.unit} onChange={set('unit')}><option value="full">Full day(s) — choose dates</option><option value="half">Half-day — single date</option></select></Field>
          <Field label="Start date *" htmlFor="projectDate"><input id="projectDate" type="date" required min={new Date(Date.now() + 3600000).toISOString().slice(0, 10)} className={inputCls} value={f.start} onChange={set('start')} /></Field>
          <Field label="End date *" htmlFor="projectEndDate"><input id="projectEndDate" type="date" required className={inputCls} value={f.end} min={f.start || undefined} disabled={f.unit === 'half'} onChange={set('end')} /></Field>
          <Field label="Production location *" htmlFor="projectLocation" full><input id="projectLocation" required className={inputCls} value={f.location} onChange={set('location')} placeholder="e.g. Lekki, Lagos" /></Field>
          <Field label="Proposed overtime rate / terms" htmlFor="overtimeTerms" full><input id="overtimeTerms" className={inputCls} value={f.overtime} onChange={set('overtime')} placeholder="e.g. ₦15,000 per additional hour, subject to crew agreement" /></Field>
          <Field label="Project brief & deliverables *" htmlFor="brief" full><textarea id="brief" required className={inputCls + ' min-h-24'} value={f.brief} onChange={set('brief')} placeholder="Describe the job, expected deliverables, schedule and any special requirements." /></Field>
        </div>
        <div className="my-4 grid gap-1.5 rounded-[13px] bg-[#f5f7f3] p-3.5 text-xs">
          {row(`Professional rate · ${daysLabel}`, naira(m.base))}
          {row('Client service fee (10%)', '+' + naira(m.clientFee))}
          {row('Crew commission (10%)', naira(m.crewFee) + ' deducted')}
          {row("Professional's estimated payout after completion", naira(m.crewNet))}
          {row('Agency gross commission', naira(m.agencyGross))}
          <div className="flex justify-between gap-4"><span>Overtime</span><span>Excluded; agree before confirmation</span></div>
          <div className="flex justify-between gap-4"><span>Payment processing / payout fees</span><span>Not included</span></div>
          <div className="mt-1.5 flex justify-between gap-4 border-t border-[#dfe4dc] pt-2.5 text-sm font-extrabold"><span>Client total before processing fees</span><motion.strong key={m.clientTotal} initial={{ scale: 1.15, color: '#527a14' }} animate={{ scale: 1, color: '#172337' }}>{naira(m.clientTotal)}</motion.strong></div>
        </div>
        <p className="my-2.5 text-[11px] text-muted">Daily rates support full-day bookings across selected calendar dates or a half-day booking on one date (estimated at 50% of the daily rate). Any overtime rate and terms must be agreed by the client and crew before booking confirmation. Commission: 10% client fee added and 10% crew commission deducted. Payout is intended after project completion. Payments are currently disabled; no money is collected through this website.</p>
        <Button variant="dark" type="submit" disabled={busy} className="w-full">{busy ? 'Sending request…' : <>Send booking request <ArrowUpRight className="size-4" aria-hidden="true" /></>}</Button>
      </form>
    </Modal>
  );
}

/* ================= Join ================= */
const blankJoin = { role: '', location: '', portfolio: '', bio: '' };
export function JoinModal({ open, user, onClose, onDone, onNeedAuth }) {
  const [f, setF] = useState(blankJoin); const [busy, setBusy] = useState(false); const toast = useToast();
  useEffect(() => { if (open) setF(blankJoin); }, [open]);
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const { ok, status, data } = await postJSON('/api/crew-applications', { name: user.name, email: user.email, role: f.role, location: f.location, portfolio: f.portfolio, bio: f.bio });
      if (!ok) { if (status === 401) { onNeedAuth(); return; } throw new Error(data.error || 'Could not submit application.'); }
      onDone(data.application);
    } catch (err) { toast(err.message || 'Could not connect to backend.'); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="joinTitle">
      <ModalHead tag="Crew application" id="joinTitle" title="Join the crew network" onClose={onClose} />
      <form onSubmit={submit}>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Full name *" htmlFor="crewName"><input id="crewName" className={inputCls} readOnly value={user?.name || ''} /></Field>
          <Field label="Email *" htmlFor="crewEmail"><input id="crewEmail" className={inputCls} readOnly value={user?.email || ''} /></Field>
          <Field label="Primary role *" htmlFor="crewRole"><select id="crewRole" required className={inputCls} value={f.role} onChange={set('role')}><option value="">Select role</option>{['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative', 'Makeup', 'Other'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Base location *" htmlFor="crewLocation"><input id="crewLocation" required className={inputCls} value={f.location} onChange={set('location')} placeholder="e.g. Lagos" /></Field>
          <Field label="Portfolio / showreel link" htmlFor="crewPortfolio" full><input id="crewPortfolio" type="url" className={inputCls} value={f.portfolio} onChange={set('portfolio')} placeholder="https://" /></Field>
          <Field label="Skills and experience *" htmlFor="crewBio" full><textarea id="crewBio" required className={inputCls + ' min-h-24'} value={f.bio} onChange={set('bio')} placeholder="Summarise your experience, credits and skills." /></Field>
        </div>
        <p className="my-3 text-[11px] text-muted">Submitting this form creates an application for review; it does not automatically publish a profile or guarantee work.</p>
        <Button variant="dark" type="submit" disabled={busy} className="w-full">{busy ? 'Submitting…' : <>Prepare crew application <ArrowUpRight className="size-4" aria-hidden="true" /></>}</Button>
      </form>
    </Modal>
  );
}

/* ================= Legal ================= */
export function LegalModal({ topic, setTopic, onClose }) {
  const policy = legalPolicies[topic] || legalPolicies.terms;
  return (
    <Modal open={!!topic} onClose={onClose} labelledBy="legalTitle" className="sm:max-w-[760px]">
      <ModalHead tag="Platform policies · Draft for review" id="legalTitle" title={policy.title} onClose={onClose} />
      <SlidingTabs id="legalTabs" value={topic || 'terms'} onChange={setTopic} className="mb-4 overflow-x-auto" tabs={[{ value: 'terms', label: 'Terms' }, { value: 'privacy', label: 'Privacy' }, { value: 'cancellation', label: 'Cancellation' }, { value: 'crew', label: 'Crew & payouts' }]} />
      <AnimatePresence mode="wait">
        <motion.article key={topic} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="legal-content" dangerouslySetInnerHTML={{ __html: policy.html }} />
      </AnimatePresence>
      <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">These are starter policy templates for testing, not legal advice. Have a qualified lawyer review them for your operating location before public launch or taking payments.</p>
    </Modal>
  );
}
