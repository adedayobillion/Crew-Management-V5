import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Button, Field, inputCls } from './ui.jsx';
import { cn, http, naira, postJSON, todayLagos } from './lib.js';

const CATS = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];
const fmt = d => { try { return new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const when = j => (String(j.start_date).slice(0, 10) === String(j.end_date).slice(0, 10) ? fmt(j.start_date) : fmt(j.start_date) + ' to ' + fmt(j.end_date));
const chip = 'rounded-full bg-[#f1f5f0] px-2.5 py-1 text-[11px] font-bold text-[#445468]';
const small = 'rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-bold text-[#445468] hover:border-ink/30';
const blank = () => ({ title: '', category: 'Camera', role: '', description: '', location: '', budget: '', startDate: todayLagos(), endDate: todayLagos() });

function JobCard({ j, user, onApply, children }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="break-words font-display text-lg font-extrabold tracking-[-.02em]">{j.title}</h3>
          <div className="mt-1.5 flex flex-wrap gap-1.5"><span className={chip}>{j.category}{j.role ? ' · ' + j.role : ''}</span><span className={chip}>{j.location}</span><span className={chip}>{when(j)}</span></div></div>
        <div className="text-right"><p className="font-display text-lg font-extrabold">{j.budget ? naira(j.budget) : 'Open budget'}</p><p className="text-[11px] text-muted">{j.applicants} applied</p></div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#445468]">{j.description}</p>
      {children}
    </div>
  );
}

export function JobBoard({ user, onLogin, toast, onBack, onOpenMessages }) {
  const [tab, setTab] = useState('board');
  const [jobs, setJobs] = useState(null); const [cat, setCat] = useState(''); const [q, setQ] = useState('');
  const [mine, setMine] = useState(null); const [posting, setPosting] = useState(false); const [f, setF] = useState(blank()); const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(null); const [ap, setAp] = useState({ message: '', quote: '' });
  const loadBoard = () => http('/api/jobs?category=' + encodeURIComponent(cat) + '&q=' + encodeURIComponent(q)).then(r => r.ok && setJobs(r.data.jobs)).catch(() => {});
  const loadMine = () => user && http('/api/my/jobs').then(r => r.ok && setMine(r.data)).catch(() => {});
  useEffect(() => { const t = setTimeout(loadBoard, 200); return () => clearTimeout(t); }, [cat, q, user?.id]);
  useEffect(() => { if (tab === 'mine') loadMine(); }, [tab, user?.id]);
  const need = () => { if (!user) { onLogin(); return true; } return false; };

  async function post(e) {
    e.preventDefault(); if (need()) return; setBusy(true);
    const r = await postJSON('/api/jobs', { ...f, budget: f.budget === '' ? null : Number(f.budget) }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { toast(r.data.error || 'Could not post the job.'); return; }
    toast('Job posted. Crew can now apply.'); setPosting(false); setF(blank()); loadBoard(); setTab('mine');
  }
  async function apply(j) {
    if (need()) return; setBusy(true);
    const r = await postJSON('/api/jobs/' + j.id + '/apply', { message: ap.message, quote: ap.quote === '' ? null : Number(ap.quote) }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { toast(r.data.error || 'Could not send your application.'); return; }
    toast('Application sent. The booker will review it.'); setApplying(null); setAp({ message: '', quote: '' }); loadBoard();
  }
  async function accept(j, a) {
    if (!confirm('Accept ' + a.name + '? This sends them a booking request for ' + when(j) + ' and closes the job.')) return;
    const r = await postJSON('/api/jobs/' + j.id + '/applications/' + a.id + '/accept', {}).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { toast(r.data.error || 'Could not accept this application.'); return; }
    toast('Booking request sent to ' + a.name + '. Continue in Messages.'); loadMine(); onOpenMessages?.();
  }
  async function close(j) {
    if (!confirm('Close this job? Crew will no longer see it.')) return;
    const r = await postJSON('/api/jobs/' + j.id + '/close', {}).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Job closed.' : (r.data.error || 'Could not close the job.')); loadMine(); loadBoard();
  }
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }));

  return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-[min(920px,calc(100%-28px))] py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="font-display text-[11px] font-extrabold uppercase tracking-[.2em] text-[#4d6b14]">Job board</p><h1 className="font-display text-3xl font-extrabold tracking-[-.04em] sm:text-4xl">Post a job. Crew come to you.</h1>
          <p className="mt-1 max-w-[560px] text-sm text-[#566274]">Describe what you need, where and your budget. Crew who can do it apply, and you pick. Hiring and payment then happen safely inside the app.</p></div>
        <div className="flex gap-2"><Button variant="ghost" onClick={onBack}>Back</Button><Button variant="dark" onClick={() => { if (!need()) setPosting(p => !p); }}>{posting ? 'Cancel' : '+ Post a job'}</Button></div>
      </div>

      {posting && (
        <form onSubmit={post} className="mt-5 grid gap-3.5 rounded-2xl border border-line bg-white p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Job title" htmlFor="jbTitle" full><input id="jbTitle" className={inputCls} required maxLength={140} value={f.title} onChange={set('title')} placeholder="e.g. Videographer for a wedding highlight film" /></Field>
          <Field label="Category" htmlFor="jbCat"><select id="jbCat" className={inputCls} value={f.category} onChange={set('category')}>{CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Role needed (optional)" htmlFor="jbRole"><input id="jbRole" className={inputCls} maxLength={80} value={f.role} onChange={set('role')} placeholder="e.g. Gaffer" /></Field>
          <Field label="Scope of work" htmlFor="jbDesc" full><textarea id="jbDesc" className={cn(inputCls, 'min-h-28')} required maxLength={3000} value={f.description} onChange={set('description')} placeholder="What is the project, how long is the day, what gear or skills do you need?" /></Field>
          <Field label="Location" htmlFor="jbLoc"><input id="jbLoc" className={inputCls} required maxLength={120} value={f.location} onChange={set('location')} placeholder="e.g. Lekki, Lagos" /></Field>
          <Field label="Budget in naira (optional)" htmlFor="jbBud"><input id="jbBud" inputMode="numeric" className={inputCls} value={f.budget} onChange={e => setF(s => ({ ...s, budget: e.target.value.replace(/\D/g, '') }))} placeholder="e.g. 150000" /></Field>
          <Field label="Start date" htmlFor="jbS"><input id="jbS" type="date" min={todayLagos()} className={inputCls} required value={f.startDate} onChange={e => setF(s => ({ ...s, startDate: e.target.value, endDate: s.endDate < e.target.value ? e.target.value : s.endDate }))} /></Field>
          <Field label="End date" htmlFor="jbE"><input id="jbE" type="date" min={f.startDate} className={inputCls} required value={f.endDate} onChange={set('endDate')} /></Field>
          <p className="text-xs text-muted sm:col-span-2">Do not put phone numbers or emails in the post. Contact details unlock once you hire someone.</p>
          <div className="sm:col-span-2"><Button variant="dark" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post job'}</Button></div>
        </form>
      )}

      <div className="mt-5 flex gap-2" role="tablist">{[['board', 'Open jobs'], ['mine', 'My jobs and applications']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => { if (k === 'mine' && need()) return; setTab(k); }} className={cn('rounded-full border px-4 py-2 text-sm font-bold', tab === k ? 'border-ink bg-ink text-white' : 'border-line bg-white text-[#445468]')}>{l}</button>)}</div>

      {tab === 'board' && (
        <div className="mt-4">
          <div className="grid gap-2.5 sm:grid-cols-[1fr_200px]"><input aria-label="Search jobs" className={inputCls} value={q} onChange={e => setQ(e.target.value)} placeholder="Search title, role or location" /><select aria-label="Category" className={inputCls} value={cat} onChange={e => setCat(e.target.value)}><option value="">All categories</option>{CATS.map(c => <option key={c}>{c}</option>)}</select></div>
          <div className="mt-4 grid gap-3">
            {jobs === null && <p className="text-sm text-muted">Loading jobs…</p>}
            {jobs && !jobs.length && <div className="rounded-2xl border border-dashed border-line bg-white p-8 text-center"><p className="font-display font-extrabold">No open jobs right now</p><p className="mt-1 text-sm text-muted">Be the first: post what you need and crew will come to you.</p></div>}
            {jobs?.map(j => (
              <JobCard key={j.id} j={j} user={user}>
                <div className="mt-3">
                  {j.mine ? <span className={chip}>Your job</span> : j.applied ? <span className="rounded-full bg-lime-soft px-3 py-1.5 text-xs font-extrabold text-[#3f6b12]">Applied</span>
                    : applying === j.id ? (
                      <div className="grid gap-2.5 rounded-xl bg-[#f7f9f6] p-3">
                        <Field label="Why you are a good fit" htmlFor={'ap' + j.id}><textarea id={'ap' + j.id} className={cn(inputCls, 'min-h-20')} maxLength={1500} value={ap.message} onChange={e => setAp(s => ({ ...s, message: e.target.value }))} placeholder="Your experience, gear and availability" /></Field>
                        <Field label="Your rate for this job, in naira (optional)" htmlFor={'aq' + j.id}><input id={'aq' + j.id} inputMode="numeric" className={inputCls} value={ap.quote} onChange={e => setAp(s => ({ ...s, quote: e.target.value.replace(/\D/g, '') }))} /></Field>
                        <div className="flex gap-2"><Button size="sm" variant="dark" disabled={busy} onClick={() => apply(j)}>{busy ? 'Sending…' : 'Send application'}</Button><Button size="sm" variant="ghost" onClick={() => setApplying(null)}>Cancel</Button></div>
                        <p className="text-[11px] text-muted">You need an approved crew profile to apply. Agree the final price in chat if you are hired.</p>
                      </div>
                    ) : <Button size="sm" variant="dark" onClick={() => { if (!need()) setApplying(j.id); }}>I can do this</Button>}
                </div>
              </JobCard>))}
          </div>
        </div>
      )}

      {tab === 'mine' && (
        <div className="mt-4 grid gap-3">
          {mine === null && <p className="text-sm text-muted">Loading…</p>}
          {mine && !mine.jobs.length && !mine.applied.length && <div className="rounded-2xl border border-dashed border-line bg-white p-8 text-center text-sm text-muted">Nothing here yet. Post a job, or apply to one from the board.</div>}
          {mine?.jobs.map(j => (
            <JobCard key={j.id} j={j} user={user}>
              <div className="mt-3 flex items-center justify-between"><span className={chip}>{j.status === 'open' ? 'Open' : j.status === 'filled' ? 'Hired' : 'Closed'}</span>{j.status === 'open' && <button className={small} onClick={() => close(j)}>Close job</button>}</div>
              {j.applications.length > 0 && <div className="mt-3 grid gap-2">{j.applications.map(a => (
                <div key={a.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{a.name} <span className="text-xs font-semibold text-muted">· {a.role}</span></p><p className="text-xs text-muted">Listed rate {naira(a.rate)} per {a.rate_unit || 'day'}{a.quote ? ' · quoted ' + naira(a.quote) : ''}</p></div>
                    {j.status === 'open' ? <Button size="sm" variant="primary" onClick={() => accept(j, a)}>Accept and book</Button> : <span className={chip}>{a.status}</span>}</div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[#445468]">{a.message}</p>
                </div>))}</div>}
              {j.status === 'open' && !j.applications.length && <p className="mt-3 text-xs text-muted">No applications yet. Crew are notified when they browse the board.</p>}
            </JobCard>))}
          {mine?.applied.length > 0 && <div className="mt-2"><p className="font-display font-extrabold">Jobs you applied to</p>{mine.applied.map(a => <div key={a.id} className="mt-2 flex items-center justify-between rounded-xl border border-line bg-white p-3 text-sm"><span className="min-w-0 truncate">{a.title} · {a.location}</span><span className={chip}>{a.status}</span></div>)}</div>}
        </div>
      )}
    </motion.section>
  );
}
