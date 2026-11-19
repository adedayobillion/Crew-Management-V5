import { useEffect, useRef, useState } from 'react';
import { Button, Field, inputCls } from './ui.jsx';
import { http, postJSON, todayLagos } from './lib.js';
const CATEGORIES = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];

const panel = 'rounded-2xl border border-line bg-white p-5';

// Crew self-service: public listing details, profile photo and personal unavailable dates.
export default function CrewListing({ toast }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [block, setBlock] = useState({ start: '', end: '' });
  const fileRef = useRef(null);

  async function load() {
    const r = await http('/api/crew/listing').catch(() => ({ ok: false, data: {} }));
    if (!r.ok) return;
    setData(r.data);
    const l = r.data.listing;
    setForm({ role: l.role, category: l.category, rate: String(l.rate || ''), skills: (l.skills || []).join(', '), showreel: l.showreel, bio: l.bio });
  }
  useEffect(() => { load(); }, []);
  if (!data || !form) return null;
  const l = data.listing;
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault(); setSaving(true);
    const r = await postJSON('/api/crew/listing', { ...form, rate: Number(form.rate) }, 'PATCH').catch(() => ({ ok: false, data: {} }));
    setSaving(false);
    toast(r.ok ? 'Your listing was updated.' : (r.data.error || 'Could not save your listing.'));
    if (r.ok) load();
  }
  async function togglePaused() {
    const r = await postJSON('/api/crew/listing', { is_active: !l.is_active }, 'PATCH').catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? (l.is_active ? 'Your listing is paused. Clients cannot find you.' : 'Your listing is live again.') : (r.data.error || 'Could not update.'));
    if (r.ok) load();
  }
  async function pickPhoto(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Choose a photo under 2 MB.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await postJSON('/api/crew/photo', { mime_type: file.type, data_base64: btoa(bin) }).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Photo updated.' : (r.data.error || 'Could not upload the photo.'));
    if (r.ok) load();
  }
  async function removePhoto() {
    const r = await http('/api/crew/photo', { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Photo removed.' : (r.data.error || 'Could not remove the photo.'));
    if (r.ok) load();
  }
  async function addBlock(e) {
    e.preventDefault();
    const r = await postJSON('/api/crew/availability', { start_date: block.start, end_date: block.end || block.start }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) { setBlock({ start: '', end: '' }); toast('Dates blocked. Clients cannot book them.'); load(); } else toast(r.data.error || 'Could not block those dates.');
  }
  async function removeBlock(id) {
    const r = await http('/api/crew/availability/' + id, { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) load(); else toast(r.data.error || 'Could not remove that block.');
  }

  return (
    <div className="mb-5 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <section className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="font-display text-xl font-extrabold">Your listing</h3><p className="mt-1 text-xs text-muted">What clients see in the marketplace. A new rate applies to new bookings only.</p></div>
          <Button size="sm" variant="ghost" onClick={togglePaused}>{l.is_active ? 'Pause my listing' : 'Make listing live'}</Button>
        </div>
        {!l.is_active && <div role="status" className="mt-3 rounded-xl bg-[#fff8e6] px-3 py-2 text-xs font-semibold text-[#7a5a0b]">Your listing is paused and hidden from the marketplace.</div>}
        <div className="mt-4 flex items-center gap-4">
          {l.photo ? <img src={l.photo} alt="Your profile" className="size-16 rounded-full object-cover" /> : <div className="grid size-16 place-items-center rounded-full bg-[#eef2ea] text-xs text-muted">No photo</div>}
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={pickPhoto} aria-label="Upload profile photo" />
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>{l.photo ? 'Change photo' : 'Upload photo'}</Button>
            {l.photo && <Button size="sm" variant="ghost" onClick={removePhoto}>Remove</Button>}
          </div>
        </div>
        <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Role" htmlFor="clRole"><input id="clRole" className={inputCls} required maxLength={80} value={form.role} onChange={set('role')} /></Field>
          <Field label="Category" htmlFor="clCat"><select id="clCat" className={inputCls} value={form.category} onChange={set('category')}>{!CATEGORIES.includes(form.category) && <option value={form.category}>{form.category || 'Choose…'}</option>}{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Daily rate (₦)" htmlFor="clRate"><input id="clRate" type="number" min="1000" max="10000000" step="500" className={inputCls} required value={form.rate} onChange={set('rate')} /></Field>
          <Field label="Showreel link" htmlFor="clReel"><input id="clReel" type="url" className={inputCls} maxLength={300} value={form.showreel} onChange={set('showreel')} placeholder="https://vimeo.com/…" /></Field>
          <Field label="Skills (comma separated)" htmlFor="clSkills" full><input id="clSkills" className={inputCls} value={form.skills} onChange={set('skills')} placeholder="Steadicam, Drone, Anamorphic" /></Field>
          <Field label="About your work" htmlFor="clBio" full><textarea id="clBio" className={inputCls + ' min-h-20'} maxLength={1000} value={form.bio} onChange={set('bio')} /></Field>
          <div className="sm:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save listing'}</Button></div>
        </form>
      </section>
      <section className={panel}>
        <h3 className="font-display text-xl font-extrabold">Dates you are unavailable</h3>
        <p className="mt-1 text-xs text-muted">Block days you are busy or away. Clients cannot request these dates.</p>
        <form onSubmit={addBlock} className="mt-3 grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="blFrom"><input id="blFrom" type="date" min={todayLagos()} required className={inputCls} value={block.start} onChange={e => setBlock(b => ({ ...b, start: e.target.value, end: b.end && b.end < e.target.value ? e.target.value : b.end }))} /></Field>
          <Field label="To (optional)" htmlFor="blTo"><input id="blTo" type="date" min={block.start || todayLagos()} className={inputCls} value={block.end} onChange={e => setBlock(b => ({ ...b, end: e.target.value }))} /></Field>
          <div className="col-span-2"><Button size="sm" type="submit">Block dates</Button></div>
        </form>
        <ul className="mt-4 grid gap-2 text-sm">
          {!data.blocks.length && <li className="text-xs text-muted">Nothing blocked.</li>}
          {data.blocks.map(b => (
            <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
              <span>{b.start_date === b.end_date ? b.start_date : b.start_date + ' to ' + b.end_date}<small className="ml-2 text-muted">{b.reason === 'personal' ? 'Blocked by you' : 'Booking'}</small></span>
              {b.reason === 'personal' && <button type="button" onClick={() => removeBlock(b.id)} className="text-xs font-bold text-[#a13232] underline">Remove</button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
