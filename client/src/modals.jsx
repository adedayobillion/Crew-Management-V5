import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, Modal, ModalHead, SlidingTabs, Tagline, inputCls, useToast } from './ui.jsx';
import { naira, postJSON, proposalBody, quote, todayLagos } from './lib.js';
import { legalPolicies } from './legal.js';
import { ArrowUpRight } from 'lucide-react';

/* ================= Auth ================= */
export function AuthModal({ open, mode, setMode, defaultRole, onClose, onSuccess, openLegal }) {
  const reg = mode === 'register', forgot = mode === 'forgot';
  const [sent, setSent] = useState('');
  const [f, setF] = useState({ name: '', email: '', phone: '', location: '', password: '', role: 'client', terms: false });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const first = useRef(null);
  useEffect(() => { if (open) { setErr(''); setSent(''); setF(s => ({ ...s, role: defaultRole || 'client' })); setTimeout(() => first.current?.focus(), 120); } }, [open, mode]);
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    if (forgot) {
      try {
        const { ok, data } = await postJSON('/api/auth/forgot', { email: f.email });
        if (!ok) throw new Error(data.error || 'Could not send the reset email.');
        setSent(data.message || 'If that email has an account, a reset link is on its way.');
      } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
      return;
    }
    const payload = reg ? { name: f.name, email: f.email, phone: f.phone, location: f.location, password: f.password, accountType: f.role, termsAccepted: f.terms } : { email: f.email, password: f.password };
    try {
      const { ok, data } = await postJSON('/api/auth/' + mode, payload);
      if (!ok) throw new Error(data.error || 'Could not authenticate.');
      setF({ name: '', email: '', phone: '', location: '', password: '', role: 'client', terms: false });
      onSuccess(data.user, mode);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="authTitle" className="sm:max-w-[470px] sm:p-8">
      <motion.div initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14, delay: 0.1 }}
        className="mb-4 grid size-[46px] place-items-center rounded-[15px] bg-lime font-display text-[22px] font-extrabold shadow-[0_6px_16px_#8ebc4655]">C.</motion.div>
      <ModalHead tag="Your production network" id="authTitle" title={reg ? 'Create your account' : forgot ? 'Reset your password' : 'Welcome back'} onClose={onClose} />
      <p className="-mt-3 mb-4 text-[13px] text-muted">{reg ? 'One account to hire crew and offer your own services. Switch between Hiring and Crew any time.' : forgot ? 'Enter your account email and we will send you a link to choose a new password.' : 'Sign in to manage your bookings and your crew profile.'}</p>
      {!forgot && <SlidingTabs id="authTabs" value={mode} onChange={setMode} tabs={[{ value: 'login', label: 'Log in' }, { value: 'register', label: 'Create account' }]} className="mb-4" />}
      <form onSubmit={submit} className="grid gap-3.5">
        <AnimatePresence initial={false}>
          {reg && (
            <motion.div key="n" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <Field label="Full name (as on your government ID)" htmlFor="authName"><input ref={first} id="authName" className={inputCls} required value={f.name} onChange={set('name')} autoComplete="name" maxLength={120} placeholder="First and last name" /></Field>
            </motion.div>
          )}
        </AnimatePresence>
        <Field label="Email address" htmlFor="authEmail"><input ref={reg ? null : first} id="authEmail" type="email" className={inputCls} required value={f.email} onChange={set('email')} autoComplete="email" maxLength={254} placeholder="you@example.com" /></Field>
        <AnimatePresence initial={false}>
          {reg && (
            <motion.div key="pl" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="grid gap-3.5 overflow-hidden">
              <Field label="Phone number" htmlFor="authPhone"><input id="authPhone" type="tel" className={inputCls} required value={f.phone} onChange={set('phone')} autoComplete="tel" maxLength={30} placeholder="+234 801 234 5678" /></Field>
              <Field label="Location" htmlFor="authLoc"><input id="authLoc" className={inputCls} required value={f.location} onChange={set('location')} autoComplete="address-level2" maxLength={120} placeholder="City, e.g. Lagos" /></Field>
            </motion.div>
          )}
        </AnimatePresence>
        {!forgot && <Field label="Password" htmlFor="authPassword"><input id="authPassword" type="password" className={inputCls} required minLength={10} maxLength={200} value={f.password} onChange={set('password')} autoComplete={reg ? 'new-password' : 'current-password'} placeholder={reg ? 'At least 10 characters, with a letter and number' : 'Your password'} /></Field>}
        {!reg && !forgot && <button type="button" onClick={() => setMode('forgot')} className="-mt-1.5 justify-self-start text-xs font-bold text-[#526f1f] underline">Forgot your password?</button>}
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
        {sent && <div role="status" className="rounded-[10px] border border-[#cfe6b0] bg-[#f3fae6] px-3 py-2.5 text-xs text-[#3f6b12]">{sent}</div>}
        <Button variant="dark" type="submit" disabled={busy} className="w-full">{forgot ? (busy ? 'Sending…' : 'Email me a reset link') : busy ? (reg ? 'Creating account…' : 'Signing in…') : (reg ? <>Create account securely <ArrowUpRight className="size-4" aria-hidden="true" /></> : <>Log in securely <ArrowUpRight className="size-4" aria-hidden="true" /></>)}</Button>
        {forgot && <button type="button" onClick={() => setMode('login')} className="text-center text-xs font-bold text-[#526f1f] underline">Back to log in</button>}
      </form>
      <p className="mt-4 text-center text-[11px] leading-relaxed text-muted">Your account is protected with a hashed password and a secure, HTTP-only session cookie. Use a unique password for this platform.</p>
    </Modal>
  );
}

export function ResetModal({ token, onClose, onDone }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const { ok, data } = await postJSON('/api/auth/reset', { token, password: pw });
      if (!ok) throw new Error(data.error || 'Could not reset your password.');
      onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <Modal open={!!token} onClose={onClose} labelledBy="resetTitle" className="sm:max-w-[440px] sm:p-8">
      <ModalHead tag="Account recovery" id="resetTitle" title="Choose a new password" onClose={onClose} />
      <form onSubmit={submit} className="grid gap-3.5">
        <Field label="New password" htmlFor="resetPw"><input id="resetPw" type="password" className={inputCls} required minLength={10} maxLength={200} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="At least 10 characters, with a letter and number" /></Field>
        {err && <div role="alert" className="rounded-[10px] border border-[#f6d5d5] bg-[#fff0f0] px-3 py-2.5 text-xs text-[#a13232]">{err}</div>}
        <Button variant="dark" type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Save new password'}</Button>
      </form>
    </Modal>
  );
}

/* ================= Booking: dates + a message; everything else is agreed in the chat ================= */
export function ProposalFields({ value, onChange, canEditRate, baseRate, hideQuote, viewer = 'client', rateUnit = 'day' }) {
  const set = patch => onChange(v => { const n = { ...v, ...patch }; if (rateUnit === 'hour' || n.unit === 'half' || (rateUnit === 'project' && n.kind === 'delivery')) n.end = n.start; else if (n.end && n.start && n.end < n.start) n.end = n.start; return n; });
  const unit = rateUnit === 'day' ? value.unit : rateUnit;
  const q = quote(unit, value.start, value.end, value.rate || baseRate, value.qty);
  const toggle = (items, cur, key) => (
    <div role="group" className="inline-flex w-fit rounded-full border border-line bg-white p-0.5 text-xs font-bold">
      {items.map(([k, l]) => <button key={k} type="button" aria-pressed={cur === k} onClick={() => set({ [key]: k })} className={'rounded-full px-3.5 py-1.5 transition ' + (cur === k ? 'bg-ink text-white' : 'text-[#566274]')}>{l}</button>)}
    </div>
  );
  const rateLabel = { day: 'Agreed daily rate (₦)', hour: 'Agreed hourly rate (₦)', project: 'Agreed project fee (₦)' }[rateUnit];
  const delivery = rateUnit === 'project' && value.kind === 'delivery';
  return (
    <div className="grid gap-3">
      {rateUnit === 'day' && toggle([['full', 'Full day(s)'], ['half', 'Half day']], value.unit, 'unit')}
      {rateUnit === 'project' && toggle([['calendar', 'Set dates'], ['delivery', 'Delivery date']], value.kind || 'calendar', 'kind')}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={delivery ? 'Deliver by' : rateUnit === 'hour' || value.unit === 'half' ? 'Date' : 'Start date'} htmlFor="pf-start"><input id="pf-start" type="date" required min={todayLagos()} className={inputCls} value={value.start} onChange={e => set({ start: e.target.value })} /></Field>
        {rateUnit === 'hour' && <Field label="Number of hours" htmlFor="pf-qty"><input id="pf-qty" type="number" required min="1" max="240" step="0.5" inputMode="decimal" className={inputCls} value={value.qty || ''} onChange={e => set({ qty: e.target.value })} /></Field>}
        {((rateUnit === 'day' && value.unit === 'full') || (rateUnit === 'project' && !delivery)) && <Field label="End date" htmlFor="pf-end"><input id="pf-end" type="date" required min={value.start || todayLagos()} className={inputCls} value={value.end} onChange={e => set({ end: e.target.value })} /></Field>}
      </div>
      {canEditRate && <Field label={rateLabel} htmlFor="pf-rate"><input id="pf-rate" type="number" min="1" step="1" inputMode="numeric" className={inputCls} value={value.rate} onChange={e => set({ rate: e.target.value })} /></Field>}
      {!hideQuote && <p className="rounded-xl bg-[#f5f7f3] px-3.5 py-2.5 text-xs text-[#445468]" aria-live="polite">
        {rateUnit === 'project' ? <>{naira(value.rate || baseRate)} flat fee</> : rateUnit === 'hour' ? <>{naira(value.rate || baseRate)}/hr × {q.days} hr{q.days === 1 ? '' : 's'}</> : <>{naira(value.rate || baseRate)}/day × {q.days} {q.days === 1 || q.days === 0.5 ? 'day' : 'days'}</>} {viewer === 'crew' ? <> − 10% commission = <strong className="text-ink">{naira(q.crewNet)}</strong> to you</> : <> + 10% service fee = <strong className="text-ink">{naira(q.clientTotal)}</strong> total</>}
      </p>}
    </div>
  );
}

export function BookingModal({ pro, user, onClose, onSent, onNeedAuth }) {
  const open = !!pro; const blank = { unit: 'full', start: '', end: '', rate: '', qty: '', kind: 'calendar' };
  const [f, setF] = useState(blank); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (open) { setF(blank); setMessage(''); } }, [pro?.id]);
  async function submit(e) {
    e.preventDefault(); if (!pro) return; setBusy(true);
    try {
      const { ok, status, data } = await postJSON('/api/bookings', { professionalId: pro.id, ...proposalBody(f, pro.rate_unit || 'day'), message });
      if (!ok) { if (status === 401) { onNeedAuth(pro); return; } throw new Error(data.error || 'Could not send your request.'); }
      onSent(data.booking);
    } catch (err) { toast(err.message || 'Could not connect to backend.'); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="bookingTitle">
      <ModalHead tag={pro ? pro.role : 'Booking request'} id="bookingTitle" title={pro ? 'Message ' + pro.name : 'Book a professional'} onClose={onClose} />
      <form onSubmit={submit} className="grid gap-4">
        <ProposalFields value={f} onChange={setF} canEditRate={false} baseRate={pro?.rate} rateUnit={pro?.rate_unit || 'day'} />
        <Field label="Your message" htmlFor="bookingMessage">
          <textarea id="bookingMessage" className={inputCls + ' min-h-24'} value={message} maxLength={2000} onChange={e => setMessage(e.target.value)} placeholder="Tell them about the job: what you're shooting, where, call time. You can agree changes to the dates and price in the chat." />
        </Field>
        <Button variant="dark" type="submit" disabled={busy || !f.start} className="w-full">{busy ? 'Sending…' : <>Send request <ArrowUpRight className="size-4" aria-hidden="true" /></>}</Button>
        <p className="text-center text-[11px] leading-relaxed text-muted">This opens a conversation in your inbox. Nothing is confirmed or charged until {pro?.name || 'the crew member'} accepts the dates and price in the chat.</p>
      </form>
    </Modal>
  );
}

export function GroupModal({ pros, user, onClose, onSent, onNeedAuth }) {
  const open = pros.length > 0; const blank = { unit: 'full', start: '', end: '', rate: '' };
  const [f, setF] = useState(blank); const [title, setTitle] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (open) { setF(blank); setTitle(''); setMessage(''); } }, [open]);
  const days = quote(f.unit, f.start, f.end || f.start, 1).days || 0;
  const base = pros.reduce((t, p) => t + Math.round(Number(p.rate) * days), 0);
  const total = base + Math.round(base * 0.1);
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const { ok, status, data } = await postJSON('/api/group-bookings', { professionalIds: pros.map(p => p.id), title, bookingUnit: f.unit, startDate: f.start, endDate: f.unit === 'half' ? f.start : (f.end || f.start), message });
      if (!ok) { if (status === 401) { onNeedAuth(); return; } throw new Error(data.error || 'Could not send your requests.'); }
      onSent(data);
    } catch (err) { toast(err.message || 'Could not connect to backend.'); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="groupTitle">
      <ModalHead tag="Group booking" id="groupTitle" title={`Book ${pros.length} professionals`} onClose={onClose} />
      <form onSubmit={submit} className="grid gap-4">
        <ul className="grid gap-1.5 rounded-xl border border-line bg-white p-3 text-sm">
          {pros.map(p => <li key={p.id} className="flex justify-between gap-3"><span><strong>{p.name}</strong> <span className="text-muted">· {p.role}</span></span><span>{naira(p.rate)}/day</span></li>)}
        </ul>
        <Field label="Project title" htmlFor="groupProject"><input id="groupProject" className={inputCls} required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Brand film shoot, Lekki" /></Field>
        <ProposalFields value={f} onChange={setF} canEditRate={false} baseRate={0} hideQuote />
        <Field label="Message to the crew" htmlFor="groupMessage"><textarea id="groupMessage" className={inputCls + ' min-h-20'} value={message} maxLength={2000} onChange={e => setMessage(e.target.value)} placeholder="What are you shooting, where, and what time is call?" /></Field>
        {f.start && days > 0 && <p className="rounded-xl bg-lime-soft p-3 text-sm">Estimated total for the group: <strong>{naira(total)}</strong> <span className="text-muted">(rates plus 10% service fee)</span></p>}
        <Button variant="dark" type="submit" disabled={busy || !f.start || !title.trim()} className="w-full">{busy ? 'Sending…' : <>Send {pros.length} requests <ArrowUpRight className="size-4" aria-hidden="true" /></>}</Button>
        <p className="text-center text-[11px] leading-relaxed text-muted">Each person gets their own chat and replies, accepts and is paid separately. Nothing is charged until each one accepts. If someone declines, the rest still go ahead.</p>
      </form>
    </Modal>
  );
}

/* ================= Join ================= */
const blankJoin = { role: '', location: '', portfolio: '', bio: '', dailyRate: '' };
export function JoinModal({ open, user, onClose, onDone, onNeedAuth, onNeedProfile }) {
  const [f, setF] = useState(blankJoin); const [busy, setBusy] = useState(false); const toast = useToast();
  useEffect(() => { if (open) setF(blankJoin); }, [open]);
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const { ok, status, data } = await postJSON('/api/crew-applications', { name: user.name, email: user.email, role: f.role, location: f.location, portfolio: f.portfolio, bio: f.bio, dailyRate: Number(f.dailyRate) });
      if (!ok) { if (status === 401) { onNeedAuth(); return; } throw new Error(data.error || 'Could not submit application.'); }
      onDone(data.application);
    } catch (err) { toast(err.message || 'Could not connect to backend.'); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="joinTitle">
      <ModalHead tag="Crew application" id="joinTitle" title="Join the crew network" onClose={onClose} />
      {!user?.isVerified && (
        <div role="alert" className="mb-4 rounded-xl border border-[#ead7a5] bg-[#fff8e6] p-4 text-sm text-[#72530b]">
          <strong className="block">Identity verification required</strong>
          <p className="mt-1">Please upload your identity document in your Profile. Once the admin verifies your account, you can publish crew listings directly.</p>
          <Button type="button" variant="dark" className="mt-3" onClick={onNeedProfile}>Go to Profile</Button>
        </div>
      )}
      <form onSubmit={submit}>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Full name *" htmlFor="crewName"><input id="crewName" className={inputCls} readOnly value={user?.name || ''} /></Field>
          <Field label="Email *" htmlFor="crewEmail"><input id="crewEmail" className={inputCls} readOnly value={user?.email || ''} /></Field>
          <Field label="Primary role *" htmlFor="crewRole"><select id="crewRole" required className={inputCls} value={f.role} onChange={set('role')}><option value="">Select role</option>{['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative', 'Makeup', 'Other'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Base location *" htmlFor="crewLocation"><input id="crewLocation" required className={inputCls} value={f.location} onChange={set('location')} placeholder="e.g. Lagos" /></Field>
          <Field label="Daily rate (₦) *" htmlFor="crewDailyRate"><input id="crewDailyRate" type="number" min="1000" max="10000000" step="1" required className={inputCls} value={f.dailyRate} onChange={set('dailyRate')} placeholder="e.g. 50000" /></Field>
          <Field label="Portfolio / showreel link" htmlFor="crewPortfolio" full><input id="crewPortfolio" type="url" className={inputCls} value={f.portfolio} onChange={set('portfolio')} placeholder="https://" /></Field>
          <Field label="Skills and experience *" htmlFor="crewBio" full><textarea id="crewBio" required className={inputCls + ' min-h-24'} value={f.bio} onChange={set('bio')} placeholder="Summarise your experience, credits and skills." /></Field>
        </div>
        <p className="my-3 text-[11px] text-muted">After your account is verified, your listing is published automatically. You can manage your listing from your Crew workspace.</p>
        <Button variant="dark" type="submit" disabled={busy || !user?.isVerified || !f.dailyRate || Number(f.dailyRate) < 1000} className="w-full">{busy ? 'Submitting…' : <>Publish crew listing <ArrowUpRight className="size-4" aria-hidden="true" /></>}</Button>
      </form>
    </Modal>
  );
}

/* ================= Legal ================= */
export function LegalModal({ topic, setTopic, onClose }) {
  const policy = legalPolicies[topic] || legalPolicies.terms;
  return (
    <Modal open={!!topic} onClose={onClose} labelledBy="legalTitle" className="sm:max-w-[760px]">
      <ModalHead tag="Platform policies" id="legalTitle" title={policy.title} onClose={onClose} />
      <SlidingTabs id="legalTabs" value={topic || 'terms'} onChange={setTopic} className="mb-4 overflow-x-auto" tabs={[{ value: 'terms', label: 'Terms' }, { value: 'privacy', label: 'Privacy' }, { value: 'cancellation', label: 'Cancellation' }, { value: 'crew', label: 'Crew & payouts' }]} />
      <AnimatePresence mode="wait">
        <motion.article key={topic} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="legal-content" dangerouslySetInnerHTML={{ __html: policy.html }} />
      </AnimatePresence>
    </Modal>
  );
}
