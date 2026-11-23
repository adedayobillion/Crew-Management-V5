import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Play, Star, X } from 'lucide-react';
import { Button, inputCls } from './ui.jsx';
import { cn, http, naira, postJSON } from './lib.js';

const ytId = u => { try { const x = new URL(u); if (/youtu\.be$/.test(x.hostname)) return x.pathname.slice(1); if (/youtube\.com$/.test(x.hostname)) return x.searchParams.get('v') || (x.pathname.match(/\/(shorts|embed)\/([\w-]{6,})/) || [])[2] || ''; } catch { /* ignore */ } return ''; };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; } };
const monthYear = d => { try { return new Date(d).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' }); } catch { return ''; } };

export function Stars({ value, size = 14 }) {
  return <span className="inline-flex" aria-label={value + ' out of 5'}>{[1, 2, 3, 4, 5].map(n => <Star key={n} style={{ width: size, height: size }} className={n <= Math.round(value) ? 'fill-[#f5b301] text-[#f5b301]' : 'text-[#d5dbe2]'} />)}</span>;
}
export function ReviewList({ reviews, empty }) {
  if (!reviews) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (!reviews.length) return <p className="p-6 text-center text-sm text-muted">{empty}</p>;
  return <div className="grid gap-2.5 p-4">{reviews.map(r => (
    <div key={r.id} className="rounded-xl border border-line bg-white p-3.5"><div className="flex items-center justify-between gap-2"><Stars value={r.rating} /><span className="text-[11px] text-muted">{r.reviewer_name} · {monthYear(r.created_at)}</span></div>{r.comment && <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-[#445468]">{r.comment}</p>}</div>))}</div>;
}

function Tile({ it, onOpen }) {
  const id = it.kind === 'link' ? ytId(it.url) : '';
  const base = 'group relative aspect-square overflow-hidden bg-[#e9eef0]';
  if (it.kind === 'image') return <button type="button" className={base} onClick={() => onOpen(it)} aria-label={it.caption || 'Open photo'}><img src={it.url} alt={it.caption} loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" /></button>;
  if (id) return <button type="button" className={base} onClick={() => onOpen(it)} aria-label={'Play video ' + it.caption}><img src={'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'} alt="" loading="lazy" className="size-full object-cover" /><span className="absolute inset-0 grid place-items-center bg-black/20"><span className="grid size-10 place-items-center rounded-full bg-white/90"><Play className="size-4 fill-ink text-ink" /></span></span></button>;
  return <a href={it.url} target="_blank" rel="noopener noreferrer nofollow" className={cn(base, 'grid place-items-center bg-ink p-2 text-center text-[11px] font-bold text-white')}><span><Play className="mx-auto mb-1 size-5" />{host(it.url)}</span></a>;
}

/* Instagram-style profile: header, stats, work grid, reviews. */
export function ProfileDrawer({ pro, onClose, onBook }) {
  const [tab, setTab] = useState('work'); const [items, setItems] = useState(null); const [reviews, setReviews] = useState(null); const [open, setOpen] = useState(null);
  useEffect(() => {
    let live = true;
    http('/api/professionals/' + pro.id + '/portfolio').then(r => live && setItems(r.ok ? r.data : [])).catch(() => live && setItems([]));
    http('/api/professionals/' + pro.id + '/reviews').then(r => live && setReviews(r.ok ? r.data.filter(x => x.reviewer_type === 'client') : [])).catch(() => live && setReviews([]));
    const k = e => { if (e.key === 'Escape') (open ? setOpen(null) : onClose()); };
    window.addEventListener('keydown', k); return () => { live = false; window.removeEventListener('keydown', k); };
  }, [pro.id, open]);
  const avg = reviews?.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null;
  const stat = (n, l) => <div className="text-center"><p className="font-display text-lg font-extrabold leading-none">{n}</p><p className="mt-1 text-[11px] text-muted">{l}</p></div>;
  return (
    <motion.div className="fixed inset-0 z-[70] flex justify-end bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <motion.aside role="dialog" aria-modal="true" aria-label={pro.name + ' profile'} initial={{ x: 60 }} animate={{ x: 0 }} className="flex h-full w-full max-w-[520px] flex-col overflow-hidden bg-[#fbfcfa]">
        <div className="flex items-center justify-between border-b border-line bg-white px-4 py-3"><strong className="truncate font-display">{pro.name}</strong><button aria-label="Close profile" onClick={onClose} className="grid size-8 place-items-center rounded-full hover:bg-[#f0f3f4]"><X className="size-4" /></button></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="bg-white px-4 pb-4 pt-5">
            <div className="flex items-center gap-4">
              <div className="grid size-[84px] shrink-0 place-items-center overflow-hidden rounded-full border-2 border-lime text-3xl text-white" style={{ background: pro.cover }}>{pro.photo ? <img src={pro.photo} alt="" className="size-full object-cover" /> : pro.symbol}</div>
              <div className="grid flex-1 grid-cols-3 gap-2">{stat(items ? items.length : '·', 'Posts')}{stat(avg ? avg.toFixed(1) : '·', 'Rating')}{stat(reviews ? reviews.length : '·', 'Reviews')}</div>
            </div>
            <h2 className="mt-3 font-display text-xl font-extrabold tracking-[-.03em]">{pro.name}</h2>
            <p className="text-sm text-muted">{pro.role} · {pro.location}</p>
            {pro.desc && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#445468]">{pro.bio || pro.desc}</p>}
            {pro.skills?.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">{pro.skills.map(s => <span key={s} className="rounded-md bg-[#f0f3f4] px-2 py-1 text-[11px] text-[#566274]">{s}</span>)}</div>}
            <div className="mt-3.5 flex items-center justify-between gap-3"><div><strong className="font-display text-lg">{naira(pro.rate)}</strong><small className="block text-[11px] text-muted">{pro.rate_unit === 'hour' ? 'per hour' : pro.rate_unit === 'project' ? 'per project' : 'per day'}</small></div><Button variant="dark" onClick={() => onBook(pro)}>Request booking</Button></div>
          </div>
          <div className="sticky top-0 z-[1] flex border-y border-line bg-white" role="tablist">{[['work', 'Work'], ['reviews', 'Reviews']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('flex-1 border-b-2 py-2.5 text-sm font-extrabold', tab === k ? 'border-ink text-ink' : 'border-transparent text-muted')}>{l}</button>)}</div>
          {tab === 'work' ? (items === null ? <p className="p-4 text-sm text-muted">Loading…</p> : items.length ? <div className="grid grid-cols-3 gap-0.5 p-0.5">{items.map(it => <Tile key={it.id} it={it} onOpen={setOpen} />)}</div> : <p className="p-8 text-center text-sm text-muted">No portfolio items yet.</p>)
            : <ReviewList reviews={reviews} empty="No reviews yet. Reviews appear after a paid job is completed." />}
        </div>
        <AnimatePresence>
          {open && (
            <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-black/85 p-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(null)}>
              <button aria-label="Close" className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-white/90"><X className="size-4" /></button>
              <div className="w-full max-w-[860px]" onClick={e => e.stopPropagation()}>
                {open.kind === 'image' ? <img src={open.url} alt={open.caption} className="mx-auto max-h-[82vh] max-w-full rounded-lg object-contain" /> : <div className="aspect-video w-full overflow-hidden rounded-lg bg-black"><iframe title={open.caption || 'Video'} className="size-full" src={'https://www.youtube-nocookie.com/embed/' + ytId(open.url)} allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>}
                {open.caption && <p className="mt-2 text-center text-sm text-white">{open.caption}</p>}
              </div>
            </motion.div>)}
        </AnimatePresence>
      </motion.aside>
    </motion.div>
  );
}

/* What crew see about the client they are working with. */
export function ClientProfileModal({ bookingId, onClose }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { http('/api/bookings/' + bookingId + '/client-profile').then(r => (r.ok ? setD(r.data) : setErr(r.data.error || 'Could not load this profile.'))).catch(() => setErr('Could not load this profile.')); }, [bookingId]);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-3" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Client profile" className="max-h-[85vh] w-full max-w-[440px] overflow-y-auto rounded-2xl bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><strong className="font-display">Client profile</strong><button aria-label="Close" onClick={onClose} className="grid size-8 place-items-center rounded-full hover:bg-[#f0f3f4]"><X className="size-4" /></button></div>
        {err && <p className="p-5 text-sm text-[#a33]">{err}</p>}
        {!d && !err && <p className="p-5 text-sm text-muted">Loading…</p>}
        {d && <>
          <div className="px-4 pt-4"><h3 className="font-display text-xl font-extrabold">{d.name}</h3><p className="text-xs text-muted">Member since {monthYear(d.member_since)}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-[#f7f9f6] p-3 text-center"><div><p className="font-display text-lg font-extrabold">{d.completed_jobs}</p><p className="text-[11px] text-muted">Paid jobs done</p></div><div><p className="font-display text-lg font-extrabold">{d.rating ? d.rating.toFixed(1) : '·'}</p><p className="text-[11px] text-muted">Rating</p></div><div><p className="font-display text-lg font-extrabold">{d.review_count}</p><p className="text-[11px] text-muted">Reviews</p></div></div></div>
          <ReviewList reviews={d.reviews} empty="No reviews from crew yet." />
        </>}
      </div>
    </div>
  );
}

/* Crew: manage photos and video links shown on the public profile. */
async function shrink(file) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82)); const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function PortfolioManager({ listingId, toast }) {
  const [items, setItems] = useState(null); const [busy, setBusy] = useState(false); const [link, setLink] = useState(''); const [cap, setCap] = useState(''); const fileRef = useRef(null);
  const load = () => http('/api/professionals/' + listingId + '/portfolio').then(r => setItems(r.ok ? r.data : [])).catch(() => setItems([]));
  useEffect(() => { setItems(null); load(); }, [listingId]);
  async function add(body) { setBusy(true); const r = await postJSON('/api/crew/listings/' + listingId + '/portfolio', { ...body, caption: cap }).catch(() => ({ ok: false, data: {} })); setBusy(false); if (!r.ok) { toast(r.data.error || 'Could not add that.'); return false; } setCap(''); load(); return true; }
  async function pick(e) { const files = [...(e.target.files || [])]; e.target.value = ''; for (const f of files.slice(0, 6)) { try { if (!(await add({ kind: 'image', data_base64: await shrink(f) }))) break; } catch { toast('That file is not a photo we can read.'); } } }
  async function del(it) { const r = await http('/api/crew/listings/' + listingId + '/portfolio/' + it.id, { method: 'DELETE' }).catch(() => ({ ok: false })); toast(r.ok ? 'Removed.' : 'Could not remove it.'); load(); }
  return (
    <div className="mt-4 rounded-xl border border-line p-3.5">
      <p className="font-display font-extrabold">Portfolio</p><p className="text-xs text-muted">Photos and video links appear on your profile as a grid, like Instagram. Up to 24 items.</p>
      <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-6">{items?.map(it => <div key={it.id} className="group relative aspect-square overflow-hidden rounded-md bg-[#e9eef0]">{it.kind === 'image' ? <img src={it.url} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center bg-ink p-1 text-center text-[10px] font-bold text-white">{host(it.url)}</div>}<button aria-label="Remove item" onClick={() => del(it)} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-white/90"><X className="size-3" /></button></div>)}</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><input aria-label="Caption" className={inputCls} maxLength={140} value={cap} onChange={e => setCap(e.target.value)} placeholder="Caption (optional)" /><input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={pick} aria-label="Upload portfolio photos" /><Button size="sm" variant="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Adding…' : 'Add photos'}</Button></div>
      <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={async e => { e.preventDefault(); if (await add({ kind: 'link', url: link })) setLink(''); }}><input aria-label="Video link" className={inputCls} inputMode="url" value={link} onChange={e => setLink(e.target.value)} placeholder="YouTube, Vimeo, Instagram or TikTok link" /><Button size="sm" variant="ghost" type="submit" disabled={busy || !link}>Add link</Button></form>
    </div>
  );
}
