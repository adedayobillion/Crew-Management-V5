import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Button, Field, inputCls } from './ui.jsx';
import { cn, http, postJSON, todayLagos } from './lib.js';
import { BRAND } from './brand.js';

const blankSheet = () => ({ title: '', project: '', date: todayLagos(), location: '', mapUrl: '', generalCall: '07:00', wrap: '', producer: '', director: '', notes: '', hospital: '', emergency: [{ name: '', phone: '' }], schedule: [{ time: '07:00', item: 'Crew call' }], crew: [], showPhones: false });
const longDate = d => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const sheetUrl = token => location.origin + '/sheet/' + token;

/* The document itself: used by the public link, the preview and the printout. */
export function SheetDocument({ sheet, updatedAt }) {
  const s = sheet; const phones = s.crew.some(c => c.phone);
  const lbl = 'text-[10px] font-extrabold uppercase tracking-[.14em] text-[#6b7686]';
  return (
    <article className="print-sheet overflow-hidden rounded-2xl border border-line bg-white text-ink shadow-[0_20px_60px_#17233714] print:rounded-none print:border-0 print:shadow-none">
      <header className="bg-ink px-5 py-5 text-white sm:px-8 sm:py-7">
        <p className="font-display text-[11px] font-extrabold uppercase tracking-[.24em] text-lime">Call sheet</p>
        <h1 className="mt-1 break-words font-display text-2xl font-extrabold tracking-[-.03em] sm:text-4xl">{s.title}</h1>
        {s.project && s.project !== s.title && <p className="mt-0.5 text-sm text-[#c5d0db]">{s.project}</p>}
        <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
          {s.date && <div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#9fb0c2]">Shoot date</p><p className="font-display text-lg font-bold">{longDate(s.date)}</p></div>}
          {s.generalCall && <div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#9fb0c2]">General call</p><p className="font-display text-3xl font-extrabold leading-none text-lime">{s.generalCall}</p></div>}
          {s.wrap && <div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#9fb0c2]">Est. wrap</p><p className="font-display text-lg font-bold">{s.wrap}</p></div>}
        </div>
      </header>
      <div className="grid grid-cols-1 gap-6 px-5 py-6 sm:px-8 [&>*]:min-w-0">
        {(s.location || s.producer || s.director) && (
          <section className="grid gap-4 sm:grid-cols-3">
            {s.location && <div className="sm:col-span-1"><p className={lbl}>Location</p><p className="mt-1 break-words text-sm font-semibold">{s.location}</p>{s.mapUrl && <a href={s.mapUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs font-bold text-[#4d6b14] underline print:hidden">Open map</a>}</div>}
            {s.producer && <div><p className={lbl}>Producer</p><p className="mt-1 text-sm font-semibold">{s.producer}</p></div>}
            {s.director && <div><p className={lbl}>Director</p><p className="mt-1 text-sm font-semibold">{s.director}</p></div>}
          </section>
        )}
        {s.schedule.length > 0 && (
          <section><p className={lbl}>Schedule</p>
            <div className="mt-2 overflow-hidden rounded-xl border border-line">
              {s.schedule.map((r, i) => <div key={i} className={cn('flex gap-4 px-3.5 py-2.5 text-sm', i % 2 ? 'bg-[#f7f9f6]' : 'bg-white')}><span className="w-14 shrink-0 font-display font-extrabold tabular-nums">{r.time || '·'}</span><span className="min-w-0 break-words">{r.item}</span></div>)}
            </div>
          </section>
        )}
        {s.crew.length > 0 && (
          <section><p className={lbl}>Crew ({s.crew.length})</p>
            <div className="mt-2 overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[300px] text-left text-sm">
                <thead className="bg-[#f1f5f0] text-[10px] font-extrabold uppercase tracking-[.1em] text-[#566274]"><tr><th className="px-2 sm:px-3.5 py-2">Name</th><th className="px-2 sm:px-3.5 py-2">Role</th><th className="px-2 sm:px-3.5 py-2">Call</th>{phones && <th className="px-2 sm:px-3.5 py-2">Phone</th>}</tr></thead>
                <tbody>{s.crew.map((c, i) => <tr key={i} className="border-t border-line"><td className="px-2 sm:px-3.5 py-2 font-semibold">{c.name}</td><td className="px-2 sm:px-3.5 py-2">{c.role}</td><td className="px-2 sm:px-3.5 py-2 font-bold tabular-nums">{c.call || s.generalCall || ''}</td>{phones && <td className="px-2 sm:px-3.5 py-2 tabular-nums">{c.phone}</td>}</tr>)}</tbody>
              </table>
            </div>
          </section>
        )}
        {s.notes && <section><p className={lbl}>Notes</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{s.notes}</p></section>}
        {(s.hospital || s.emergency.length > 0) && (
          <section className="rounded-xl border border-[#f1d28a] bg-[#fff8e6] p-4">
            <p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#7a5a0b]">Safety</p>
            {s.hospital && <p className="mt-1 text-sm"><strong>Nearest hospital:</strong> {s.hospital}</p>}
            {s.emergency.map((e, i) => <p key={i} className="mt-0.5 text-sm"><strong>{e.name || 'Emergency contact'}:</strong> {e.phone}</p>)}
          </section>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-[#f7f9f6] px-5 py-3 text-[11px] text-muted sm:px-8">
        <span>Made free with <strong className="text-ink">{BRAND}</strong></span>{updatedAt && <span>Updated {new Date(updatedAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
      </footer>
    </article>
  );
}

/* Public page: anyone with the link can read and print it. */
export function CallSheetView({ token }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { http('/api/public/callsheets/' + encodeURIComponent(token)).then(r => setState(r.ok ? { sheet: r.data.sheet, updatedAt: r.data.updated_at } : { error: r.data.error || 'This call sheet link is not valid any more.' })).catch(() => setState({ error: 'Could not load this call sheet.' })); }, [token]);
  return (
    <div className="min-h-screen bg-canvas px-3 py-5 sm:py-10">
      <div className="mx-auto w-full max-w-[820px]">
        <div className="mb-3 flex items-center justify-between gap-3 print:hidden">
          <a href="/" className="font-display text-sm font-extrabold tracking-[-.02em]">{BRAND}</a>
          {state.sheet && <Button size="sm" variant="dark" onClick={() => window.print()}>Print or save as PDF</Button>}
        </div>
        {state.loading && <p className="p-10 text-center text-sm text-muted">Loading call sheet…</p>}
        {state.error && <div className="rounded-2xl border border-line bg-white p-8 text-center"><p className="font-display text-lg font-extrabold">Call sheet not found</p><p className="mt-1 text-sm text-muted">{state.error}</p></div>}
        {state.sheet && <SheetDocument sheet={state.sheet} updatedAt={state.updatedAt} />}
        <p className="mt-4 text-center text-xs text-muted print:hidden">Need crew for your next shoot? <a className="font-bold underline" href="/#discover">Find professionals on {BRAND}</a></p>
      </div>
    </div>
  );
}

const rowBtn = 'rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-bold text-[#445468] hover:border-ink/30';

/* The builder (Tools → Call sheet). Free for any account. */
export function CallSheetTool({ user, onLogin, toast, onBack }) {
  const [sheets, setSheets] = useState(null);
  const [editing, setEditing] = useState(null); // { id?, token?, data }
  const [busy, setBusy] = useState(false);
  const load = () => http('/api/callsheets').then(r => r.ok && setSheets(r.data.sheets)).catch(() => {});
  useEffect(() => { if (user) load(); }, [user?.id]);

  if (!user) return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-[min(820px,calc(100%-28px))] py-12 text-center">
      <p className="font-display text-[11px] font-extrabold uppercase tracking-[.2em] text-[#4d6b14]">Free tool</p>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-[-.04em] sm:text-5xl">Call sheets in two minutes.</h1>
      <p className="mx-auto mt-3 max-w-[560px] text-sm leading-relaxed text-[#566274] sm:text-base">Build a clean call sheet with schedule, crew list and safety details. Share one link with your whole crew, or print it as a PDF. Free with any account.</p>
      <div className="mt-6 flex justify-center gap-2.5"><Button variant="dark" onClick={onLogin}>Log in or sign up to start</Button><Button variant="ghost" onClick={onBack}>Back</Button></div>
    </motion.section>
  );

  async function save(share) {
    if (!editing.data.title.trim()) { toast('Give the call sheet a title.'); return; }
    setBusy(true);
    const r = await (editing.id ? postJSON('/api/callsheets/' + editing.id, editing.data, 'PUT') : postJSON('/api/callsheets', editing.data)).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { toast(r.data.error || 'Could not save the call sheet.'); return; }
    setEditing({ id: r.data.sheet.id, token: r.data.sheet.token, data: { ...blankSheet(), ...r.data.sheet.data }, updatedAt: r.data.sheet.updated_at, saved: true });
    toast(share ? 'Saved. Copy the link below to share it.' : 'Call sheet saved.'); load();
  }
  async function remove(sh) {
    if (!confirm('Delete this call sheet? Its shared link will stop working.')) return;
    const r = await http('/api/callsheets/' + sh.id, { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) { toast('Call sheet deleted.'); if (editing?.id === sh.id) setEditing(null); load(); } else toast(r.data.error || 'Could not delete it.');
  }
  async function notify() {
    const r = await postJSON('/api/callsheets/' + editing.id + '/notify', {}).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Sent to ' + r.data.notified + ' booked crew member' + (r.data.notified === 1 ? '' : 's') + '.' : (r.data.error || 'Could not notify the crew.'));
  }
  async function addBooked() {
    const r = await http('/api/callsheets/booked-crew?date=' + encodeURIComponent(editing.data.date || '')).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { toast(r.data.error || 'Could not load your booked crew.'); return; }
    const have = new Set(editing.data.crew.map(c => c.bookingId).filter(Boolean));
    const fresh = r.data.crew.filter(c => !have.has(c.bookingId));
    if (!fresh.length) { toast(r.data.crew.length ? 'Your booked crew are already on the sheet.' : 'No confirmed bookings found for that date.'); return; }
    upd({ crew: [...editing.data.crew, ...fresh.map(c => ({ ...c, call: editing.data.generalCall }))] });
    toast(fresh.length + ' booked crew added.');
  }
  const upd = patch => setEditing(e => ({ ...e, saved: false, data: { ...e.data, ...patch } }));
  const setRow = (key, i, patch) => upd({ [key]: editing.data[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRow = (key, row) => upd({ [key]: [...editing.data[key], row] });
  const delRow = (key, i) => upd({ [key]: editing.data[key].filter((_, j) => j !== i) });

  if (!editing) return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-[min(920px,calc(100%-28px))] py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="font-display text-[11px] font-extrabold uppercase tracking-[.2em] text-[#4d6b14]">Free tool</p><h1 className="font-display text-3xl font-extrabold tracking-[-.04em]">Call sheets</h1></div>
        <div className="flex gap-2"><Button variant="ghost" onClick={onBack}>Back</Button><Button variant="dark" onClick={() => setEditing({ data: blankSheet() })}>+ New call sheet</Button></div>
      </div>
      <div className="mt-5 grid gap-3">
        {sheets === null && <p className="text-sm text-muted">Loading…</p>}
        {sheets && !sheets.length && <div className="rounded-2xl border border-dashed border-line bg-white p-8 text-center"><p className="font-display font-extrabold">No call sheets yet</p><p className="mt-1 text-sm text-muted">Create your first one. It takes about two minutes.</p></div>}
        {sheets?.map(sh => (
          <div key={sh.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-4">
            <div className="min-w-0"><p className="truncate font-display font-extrabold">{sh.data.title}</p><p className="text-xs text-muted">{sh.data.date ? longDate(sh.data.date) : 'No date'} · {sh.data.crew?.length || 0} crew · updated {new Date(sh.updated_at).toLocaleDateString('en-NG')}</p></div>
            <div className="flex gap-1.5"><button className={rowBtn} onClick={() => setEditing({ id: sh.id, token: sh.token, data: { ...blankSheet(), ...sh.data }, updatedAt: sh.updated_at, saved: true })}>Edit and share</button><button className={rowBtn} onClick={() => remove(sh)}>Delete</button></div>
          </div>))}
      </div>
    </motion.section>
  );

  const d = editing.data;
  return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-[min(920px,calc(100%-28px))] py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <button type="button" className={rowBtn} onClick={() => { setEditing(null); load(); }}>← All call sheets</button>
        <div className="flex gap-2"><Button variant="ghost" onClick={() => window.print()} disabled={!d.title}>Print or PDF</Button><Button variant="dark" onClick={() => save(true)} disabled={busy}>{busy ? 'Saving…' : editing.id ? 'Save changes' : 'Save and get link'}</Button></div>
      </div>
      {editing.token && (
        <div className="mt-3 rounded-2xl border border-lime-deep/40 bg-lime-soft p-4 print:hidden">
          <p className="text-xs font-extrabold uppercase tracking-[.1em] text-[#4d6b14]">Share link · anyone with it can view</p>
          <div className="mt-2 flex flex-wrap items-center gap-2"><input readOnly aria-label="Share link" className={cn(inputCls, 'min-w-0 flex-1')} value={sheetUrl(editing.token)} onFocus={e => e.target.select()} />
            <button className={rowBtn} onClick={() => navigator.clipboard?.writeText(sheetUrl(editing.token)).then(() => toast('Link copied.'), () => toast('Select the link and copy it.'))}>Copy</button>
            <a className={rowBtn} href={sheetUrl(editing.token)} target="_blank" rel="noopener noreferrer">Open</a>
            {d.crew.some(c => c.bookingId) && <button className={rowBtn} onClick={notify}>Notify booked crew</button>}</div>
          {!editing.saved && <p className="mt-2 text-xs font-semibold text-[#7a5a0b]">You have unsaved changes. Save so the shared link shows them.</p>}
        </div>)}
      <div className="mt-4 grid gap-4 print:hidden lg:grid-cols-[1fr]">
        <div className="grid gap-3.5 rounded-2xl border border-line bg-white p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Call sheet title" htmlFor="csTitle" full><input id="csTitle" className={inputCls} maxLength={120} value={d.title} onChange={e => upd({ title: e.target.value })} placeholder="e.g. Brand film · Day 1" /></Field>
          <Field label="Project" htmlFor="csProject"><input id="csProject" className={inputCls} maxLength={120} value={d.project} onChange={e => upd({ project: e.target.value })} /></Field>
          <Field label="Shoot date" htmlFor="csDate"><input id="csDate" type="date" className={inputCls} value={d.date} onChange={e => upd({ date: e.target.value })} /></Field>
          <Field label="General call" htmlFor="csCall"><input id="csCall" type="time" className={inputCls} value={d.generalCall} onChange={e => upd({ generalCall: e.target.value })} /></Field>
          <Field label="Estimated wrap" htmlFor="csWrap"><input id="csWrap" type="time" className={inputCls} value={d.wrap} onChange={e => upd({ wrap: e.target.value })} /></Field>
          <Field label="Location" htmlFor="csLoc" full><input id="csLoc" className={inputCls} maxLength={200} value={d.location} onChange={e => upd({ location: e.target.value })} placeholder="Address or venue" /></Field>
          <Field label="Map link (optional)" htmlFor="csMap" full><input id="csMap" inputMode="url" className={inputCls} value={d.mapUrl} onChange={e => upd({ mapUrl: e.target.value })} placeholder="https://maps.google.com/…" /></Field>
          <Field label="Producer" htmlFor="csProd"><input id="csProd" className={inputCls} maxLength={80} value={d.producer} onChange={e => upd({ producer: e.target.value })} /></Field>
          <Field label="Director" htmlFor="csDir"><input id="csDir" className={inputCls} maxLength={80} value={d.director} onChange={e => upd({ director: e.target.value })} /></Field>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between"><h2 className="font-display font-extrabold">Schedule</h2><button className={rowBtn} onClick={() => addRow('schedule', { time: '', item: '' })}>+ Add</button></div>
          <div className="mt-3 grid gap-2">{d.schedule.map((r, i) => (
            <div key={i} className="flex gap-2"><input aria-label="Time" type="time" className={cn(inputCls, 'w-[120px] shrink-0')} value={r.time} onChange={e => setRow('schedule', i, { time: e.target.value })} /><input aria-label="What happens" className={inputCls} maxLength={200} value={r.item} onChange={e => setRow('schedule', i, { item: e.target.value })} placeholder="What happens" /><button className={rowBtn} aria-label="Remove row" onClick={() => delRow('schedule', i)}>✕</button></div>))}</div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display font-extrabold">Crew</h2><div className="flex gap-2"><button className={rowBtn} onClick={addBooked}>Add my booked crew</button><button className={rowBtn} onClick={() => addRow('crew', { name: '', role: '', call: d.generalCall, phone: '' })}>+ Add person</button></div></div>
          <div className="mt-3 grid gap-3">{d.crew.map((c, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-line p-2.5 sm:grid-cols-[1.2fr_1fr_110px_1fr_auto] sm:border-0 sm:p-0">
              <input aria-label="Name" className={inputCls} maxLength={80} value={c.name} onChange={e => setRow('crew', i, { name: e.target.value })} placeholder="Name" />
              <input aria-label="Role" className={inputCls} maxLength={80} value={c.role} onChange={e => setRow('crew', i, { role: e.target.value })} placeholder="Role" />
              <input aria-label="Call time" type="time" className={inputCls} value={c.call} onChange={e => setRow('crew', i, { call: e.target.value })} />
              <input aria-label="Phone" inputMode="tel" className={inputCls} maxLength={30} value={c.phone} onChange={e => setRow('crew', i, { phone: e.target.value })} placeholder="Phone (optional)" />
              <button className={rowBtn} aria-label="Remove person" onClick={() => delRow('crew', i)}>✕</button>
              {c.bookingId && <p className="text-[11px] font-semibold text-[#4d6b14] sm:col-span-5">Booked through {BRAND}</p>}
            </div>))}
            {!d.crew.length && <p className="text-sm text-muted">No crew yet. Add booked crew in one tap, or add people by hand.</p>}</div>
          <label className="mt-4 flex items-start gap-2.5 rounded-xl bg-[#f7f9f6] p-3 text-xs leading-relaxed text-[#445468]"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={d.showPhones} onChange={e => upd({ showPhones: e.target.checked })} /><span><strong>Show crew phone numbers on the shared link.</strong> Off by default, because anyone with the link can read it. Phone numbers of crew booked here only fill in once the booking is paid.</span></label>
        </div>

        <div className="grid gap-3.5 rounded-2xl border border-line bg-white p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Notes for the crew" htmlFor="csNotes" full><textarea id="csNotes" className={cn(inputCls, 'min-h-24')} maxLength={2000} value={d.notes} onChange={e => upd({ notes: e.target.value })} placeholder="Parking, dress code, meals, what to bring…" /></Field>
          <Field label="Nearest hospital" htmlFor="csHosp" full><input id="csHosp" className={inputCls} maxLength={200} value={d.hospital} onChange={e => upd({ hospital: e.target.value })} placeholder="Name and address" /></Field>
          <div className="sm:col-span-2"><div className="flex items-center justify-between"><p className="text-[11px] font-extrabold uppercase tracking-[.08em] text-[#566274]">Emergency contacts</p><button className={rowBtn} onClick={() => addRow('emergency', { name: '', phone: '' })}>+ Add</button></div>
            <div className="mt-2 grid gap-2">{d.emergency.map((e, i) => <div key={i} className="flex gap-2"><input aria-label="Contact name" className={inputCls} maxLength={80} value={e.name} onChange={ev => setRow('emergency', i, { name: ev.target.value })} placeholder="Name" /><input aria-label="Contact phone" inputMode="tel" className={inputCls} maxLength={30} value={e.phone} onChange={ev => setRow('emergency', i, { phone: ev.target.value })} placeholder="Phone" /><button className={rowBtn} aria-label="Remove contact" onClick={() => delRow('emergency', i)}>✕</button></div>)}</div></div>
        </div>
      </div>
      <div className="mt-6"><p className="mb-2 text-xs font-extrabold uppercase tracking-[.1em] text-muted print:hidden">Preview</p><SheetDocument sheet={{ ...blankSheet(), ...d, crew: d.crew.filter(c => c.name.trim()), schedule: d.schedule.filter(r => r.item.trim()), emergency: d.emergency.filter(e => e.name || e.phone) }} updatedAt={editing.updatedAt} /></div>
    </motion.section>
  );
}
