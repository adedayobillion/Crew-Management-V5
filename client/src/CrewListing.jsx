import { PortfolioManager } from './Profile.jsx';
import { useEffect, useRef, useState } from 'react';
import { Button, Field, inputCls } from './ui.jsx';
import { http, postJSON, todayLagos } from './lib.js';
import { ExternalLink, Plus, Pencil } from 'lucide-react';

const CATEGORIES = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];
const panel = 'rounded-2xl border border-line bg-white p-5';
const emptyForm = { role: '', category: 'Camera', location: '', rate: '', rateUnit: 'day', skills: '', showreel: '', bio: '' };

export default function CrewListing({ toast }) {
  const [data, setData] = useState(null);
  const [listings, setListings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [block, setBlock] = useState({ start: '', end: '' });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [stagedPhoto, setStagedPhoto] = useState(null); // { file, url } chosen but not saved yet
  useEffect(() => () => { if (stagedPhoto) URL.revokeObjectURL(stagedPhoto.url); }, [stagedPhoto]);
  useEffect(() => { setStagedPhoto(null); }, [selectedId]);
  const fileRef = useRef(null);
  const selected = listings.find(x => Number(x.id) === Number(selectedId)) || null;

  async function load(preferredId) {
    const r = await http('/api/crew/listing').catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { toast(r.data.error || 'Could not load your listings.'); return; }
    const next = r.data.listings || (r.data.listing ? [r.data.listing] : []);
    setData(r.data);
    setListings(next);
    const id = preferredId || selectedId || next[0]?.id || null;
    const active = next.find(x => Number(x.id) === Number(id)) || next[0] || null;
    setSelectedId(active?.id || null);
    setForm(active ? toForm(active) : emptyForm);
    setEditing(false);
  }
  function toForm(l) {
    return { role: l.role || '', category: l.category || 'Camera', location: l.location || '', rate: String(l.rate || ''), rateUnit: l.rate_unit || 'day', skills: (Array.isArray(l.skills) ? l.skills : []).join(', '), showreel: l.showreel || '', bio: l.bio || '' };
  }
  useEffect(() => { load(); }, []);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  function chooseListing(id) {
    const l = listings.find(x => Number(x.id) === Number(id));
    setSelectedId(Number(id));
    setForm(l ? toForm(l) : emptyForm);
    setEditing(false);
  }
  function startNew() { setSelectedId(null); setForm(emptyForm); setEditing(true); }
  async function save(e) {
    e.preventDefault(); setSaving(true);
    const payload = { ...form, rate: Number(form.rate), skills: form.skills.split(',').map(x => x.trim()).filter(Boolean) };
    const r = selectedId
      ? await postJSON('/api/crew/listings/' + selectedId, payload, 'PATCH').catch(() => ({ ok: false, data: {} }))
      : await postJSON('/api/crew/listings', payload).catch(() => ({ ok: false, data: {} }));
    setSaving(false);
    if (!r.ok) { toast(r.data.error || 'Could not save this listing.'); return; }
    toast(selectedId ? 'Listing updated. Your marketplace profile now reflects the changes.' : 'New listing published to the marketplace.');
    await load(r.data.listing?.id);
  }
  async function togglePaused() {
    if (!selected) return;
    const r = await postJSON('/api/crew/listings/' + selected.id, { is_active: !selected.is_active }, 'PATCH').catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? (selected.is_active ? 'Listing paused and hidden from clients.' : 'Listing is live again.') : (r.data.error || 'Could not update listing.'));
    if (r.ok) load(selected.id);
  }
  async function deleteListing() {
    if (!selected) return;
    if (!confirm('Delete this listing permanently? It disappears from the marketplace and its portfolio is removed. Past bookings and reviews are kept.')) return;
    const r = await http('/api/crew/listings/' + selected.id, { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Listing deleted.' : (r.data.error || 'Could not delete the listing.'));
    if (r.ok) load();
  }
  function pickPhoto(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || !selected) return;
    if (file.size > 2 * 1024 * 1024) { toast('Choose a photo under 2 MB.'); return; }
    setStagedPhoto({ file, url: URL.createObjectURL(file) });
  }
  async function savePhoto() {
    if (!stagedPhoto || !selected) return;
    setPhotoBusy(true);
    try {
      const file = stagedPhoto.file;
      const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await postJSON('/api/crew/listings/' + selected.id + '/photo', { mime_type: file.type, data_base64: btoa(bin) });
      if (!r.ok) throw new Error(r.data.error || 'Could not upload the photo.');
      setStagedPhoto(null); toast('Listing photo saved.'); await load(selected.id);
    } catch (err) { toast(err.message); } finally { setPhotoBusy(false); }
  }
  async function removePhoto() {
    if (!selected) return;
    const r = await http('/api/crew/listings/' + selected.id + '/photo', { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    toast(r.ok ? 'Photo removed.' : (r.data.error || 'Could not remove the photo.'));
    if (r.ok) load(selected.id);
  }
  async function addBlock(e) {
    e.preventDefault();
    if (!selected) return;
    const r = await postJSON('/api/crew/availability', { professional_id: selected.id, start_date: block.start, end_date: block.end || block.start }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) { setBlock({ start: '', end: '' }); toast('Dates blocked.'); load(selected.id); } else toast(r.data.error || 'Could not block those dates.');
  }
  async function removeBlock(id) {
    const r = await http('/api/crew/availability/' + id, { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) load(selected?.id); else toast(r.data.error || 'Could not remove that block.');
  }
  const blocks = (data?.blocks || []).filter(b => !selected || Number(b.professional_id) === Number(selected.id));

  return (
    <div className="mb-5 grid gap-4">
      <section className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="font-display text-xl font-extrabold">Your professional listings</h3><p className="mt-1 text-xs text-muted">Create separate marketplace listings for each role or service. Edit them whenever your details, rate or portfolio changes.</p></div>
          <Button size="sm" onClick={startNew}><Plus className="size-4" />Add listing</Button>
        </div>
        {!!listings.length && (
          <div className="mt-4 flex flex-wrap gap-2">
            {listings.map(l => <button type="button" key={l.id} onClick={() => chooseListing(l.id)} className={'rounded-full border px-3 py-2 text-xs font-bold ' + (Number(selectedId) === Number(l.id) ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink')}>{l.role}{!l.is_active ? ' · Paused' : ''}</button>)}
          </div>
        )}
        {!selected && !editing && <div className="mt-4 rounded-xl border border-dashed border-line p-5 text-sm text-muted">No listing found. Add your first listing to appear in the marketplace.</div>}
        {editing && (
          <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Professional role" htmlFor="clRole"><input id="clRole" className={inputCls} required maxLength={80} value={form.role} onChange={set('role')} placeholder="e.g. Director of Photography" /></Field>
            <Field label="Category" htmlFor="clCat"><select id="clCat" className={inputCls} value={form.category} onChange={set('category')}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Location" htmlFor="clLocation"><input id="clLocation" className={inputCls} maxLength={120} value={form.location} onChange={set('location')} placeholder="Lagos, Nigeria" /></Field>
            <Field label="How do you charge?" htmlFor="clUnit"><select id="clUnit" className={inputCls} value={form.rateUnit} onChange={set('rateUnit')}><option value="day">Per day (full or half day)</option><option value="hour">Per hour</option><option value="project">Flat project fee</option></select></Field>
            <Field label={form.rateUnit === 'hour' ? 'Hourly rate (₦)' : form.rateUnit === 'project' ? 'Starting project fee (₦)' : 'Daily rate (₦)'} htmlFor="clRate"><input id="clRate" type="number" min="1000" max="10000000" step="500" className={inputCls} required value={form.rate} onChange={set('rate')} /></Field>
            <Field label="Skills (comma separated)" htmlFor="clSkills" full><input id="clSkills" className={inputCls} value={form.skills} onChange={set('skills')} placeholder="Steadicam, Drone, Anamorphic" /></Field>
            <Field label="About this service (required, at least 20 characters)" htmlFor="clBio" full><textarea id="clBio" className={inputCls + ' min-h-24'} required minLength={20} maxLength={1000} value={form.bio} onChange={set('bio')} placeholder="Describe your experience and the work you offer." /></Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : selectedId ? 'Save listing changes' : 'Publish new listing'}</Button><Button type="button" variant="ghost" onClick={() => { setEditing(false); if (selected) setForm(toForm(selected)); else setForm(emptyForm); }}>Cancel</Button></div>
          </form>
        )}
        {selected && !editing && (
          <div className="mt-4 rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {selected.photo ? <img src={selected.photo} alt="" className="size-14 rounded-xl object-cover" /> : <div className="grid size-14 place-items-center rounded-xl bg-[#eef2ea] text-xs text-muted">No photo</div>}
                <div><strong className="block">{selected.role}</strong><span className="text-xs text-muted">{selected.category} · {selected.location} · ₦{Number(selected.rate).toLocaleString('en-NG')}{selected.rate_unit === 'hour' ? '/hour' : selected.rate_unit === 'project' ? ' per project' : '/day'}</span><span className="mt-1 block text-[11px] text-muted">{selected.is_active ? 'Live on marketplace' : 'Paused'}</span></div>
              </div>
              <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { setForm(toForm(selected)); setEditing(true); }}><Pencil className="size-3.5" />Edit listing</Button><Button size="sm" variant="ghost" onClick={togglePaused}>{selected.is_active ? 'Pause listing' : 'Publish listing'}</Button><Button size="sm" variant="ghost" onClick={deleteListing}>Delete listing</Button></div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={pickPhoto} aria-label="Upload listing photo" />
              {stagedPhoto ? (
                <>
                  <img src={stagedPhoto.url} alt="Selected photo preview" className="size-14 rounded-xl object-cover ring-2 ring-[#8cab48]" />
                  <Button size="sm" disabled={photoBusy} onClick={savePhoto}>{photoBusy ? 'Saving…' : 'Save photo'}</Button>
                  <Button size="sm" variant="ghost" disabled={photoBusy} onClick={() => setStagedPhoto(null)}>Cancel</Button>
                </>
              ) : <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>{selected.photo ? 'Change photo' : 'Upload photo'}</Button>}
              {selected.photo && !stagedPhoto && <Button size="sm" variant="ghost" onClick={removePhoto}>Remove photo</Button>}
            </div>
            {selected.bio && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted">{selected.bio}</p>}
            <PortfolioManager listingId={selected.id} toast={toast} />
            {!!selected.skills?.length && <div className="mt-3 flex flex-wrap gap-1.5">{selected.skills.map(x => <span key={x} className="rounded-md bg-[#f0f3f4] px-2 py-1 text-[10px] text-[#566274]">{x}</span>)}</div>}
          </div>
        )}
      </section>
      {selected && (
        <section className={panel}>
          <h3 className="font-display text-xl font-extrabold">Availability for {selected.role}</h3>
          <p className="mt-1 text-xs text-muted">Block days you are busy or away. These dates apply only to this listing.</p>
          <form onSubmit={addBlock} className="mt-3 grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="blFrom"><input id="blFrom" type="date" min={todayLagos()} required className={inputCls} value={block.start} onChange={e => setBlock(b => ({ ...b, start: e.target.value, end: b.end && b.end < e.target.value ? e.target.value : b.end }))} /></Field>
            <Field label="To (optional)" htmlFor="blTo"><input id="blTo" type="date" min={block.start || todayLagos()} className={inputCls} value={block.end} onChange={e => setBlock(b => ({ ...b, end: e.target.value }))} /></Field>
            <div className="col-span-2"><Button size="sm" type="submit">Block dates</Button></div>
          </form>
          <ul className="mt-4 grid gap-2 text-sm">
            {!blocks.length && <li className="text-xs text-muted">Nothing blocked.</li>}
            {blocks.map(b => <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2"><span>{b.start_date === b.end_date ? b.start_date : b.start_date + ' to ' + b.end_date}<small className="ml-2 text-muted">{b.reason === 'personal' ? 'Blocked by you' : 'Booking'}</small></span>{b.reason === 'personal' && <button type="button" onClick={() => removeBlock(b.id)} className="text-xs font-bold text-[#a13232] underline">Remove</button>}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
