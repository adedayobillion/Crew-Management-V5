import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, Tagline, inputCls } from './ui.jsx';
import { http, naira, postJSON, proposalBody } from './lib.js';
import { ProposalFields } from './modals.jsx';
import { ClientProfileModal, ProfileDrawer } from './Profile.jsx';
import { ArrowLeft, CalendarClock, Check, CreditCard, FileText, Star, X } from 'lucide-react';

const documentLabels = {
  national_id: 'National ID',
  passport: 'International passport',
  drivers_license: "Driver's licence",
  voters_card: "Voter's card",
  other: 'Other government-issued ID'
};
const reviewStyles = {
  pending: 'bg-[#fff1d6] text-[#92400e]',
  approved: 'bg-[#e4f8c7] text-[#365314]',
  rejected: 'bg-[#fee4e2] text-[#b42318]'
};
const panel = 'rounded-[18px] border border-line bg-white p-5 shadow-[0_8px_30px_#17233708]';

export function ProfilePage({ user, onBack, onUserUpdated, onSettingsUpdated, onSignedOut }) {
  const [pw, setPw] = useState({ current: '', next: '' });
  const [delPw, setDelPw] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState({ message_popups: true, email_notifications: true, profile_visibility: true });
  const [documents, setDocuments] = useState([]);
  const [form, setForm] = useState({ name: user?.name || '', phone: '', location: '', bio: '' });
  const [docType, setDocType] = useState('national_id');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState({ text: '', error: false });

  const load = useCallback(async () => {
    setLoading(true);
    const r = await http('/api/profile').catch(() => ({ ok: false, data: { error: 'Could not connect to the server.' } }));
    if (!r.ok) {
      setNotice({ text: r.data.error || 'Could not load your profile.', error: true });
      setLoading(false);
      return;
    }
    setProfile(r.data.user);
    setForm({
      name: r.data.user.name || '',
      phone: r.data.user.phone || '',
      location: r.data.user.location || '',
      bio: r.data.user.bio || ''
    });
    setSettings(r.data.settings || { message_popups: true, email_notifications: true, profile_visibility: true });
    setDocuments(r.data.documents || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changePassword(e) {
    e.preventDefault();
    const r = await postJSON('/api/auth/change-password', { current: pw.current, password: pw.next }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) { setPw({ current: '', next: '' }); setNotice({ text: 'Password changed. Other devices have been signed out.', error: false }); }
    else setNotice({ text: r.data.error || 'Could not change your password.', error: true });
  }
  async function deleteAccount(e) {
    e.preventDefault();
    const r = await postJSON('/api/account/delete', { password: delPw }).catch(() => ({ ok: false, data: {} }));
    if (r.ok) onSignedOut?.();
    else setNotice({ text: r.data.error || 'Could not delete your account.', error: true });
  }
  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true);
    const r = await postJSON('/api/profile', form, 'PATCH').catch(() => ({ ok: false, data: {} }));
    setSaving(false);
    if (!r.ok) { setNotice({ text: r.data.error || 'Could not save your profile.', error: true }); return; }
    setProfile(r.data.user);
    onUserUpdated?.(r.data.user);
    setNotice({ text: 'Profile updated.', error: false });
  }

  async function saveSetting(key, value) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    const r = await postJSON('/api/profile/settings', { [key]: value }, 'PATCH').catch(() => ({ ok: false, data: {} }));
    if (!r.ok) {
      setNotice({ text: r.data.error || 'Could not save this setting.', error: true });
      await load();
      return;
    }
    setSettings(r.data.settings);
    onSettingsUpdated?.(r.data.settings);
    setNotice({ text: 'Settings saved.', error: false });
  }

  async function uploadId(e) {
    e.preventDefault();
    if (!file) { setNotice({ text: 'Choose a document first.', error: true }); return; }
    if (file.size > 5 * 1024 * 1024) { setNotice({ text: 'Choose a file smaller than 5 MB.', error: true }); return; }
    const mime = file.type || (/\.(jpe?g)$/i.test(file.name) ? 'image/jpeg' : /\.png$/i.test(file.name) ? 'image/png' : /\.pdf$/i.test(file.name) ? 'application/pdf' : '');
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await postJSON('/api/profile/ids', {
        document_type: docType,
        filename: file.name,
        mime_type: mime,
        data_base64: btoa(binary)
      });
      if (!r.ok) throw new Error(r.data.error || 'Could not upload your ID.');
      setFile(null);
      const input = document.getElementById('profileIdFile');
      if (input) input.value = '';
      await load();
      setNotice({ text: 'ID uploaded securely and submitted for review.', error: false });
    } catch (err) {
      setNotice({ text: err.message || 'Could not upload your ID.', error: true });
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(id) {
    if (!window.confirm('Remove this identity document? You can upload a replacement later.')) return;
    const r = await http('/api/profile/ids/' + id, { method: 'DELETE' }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { setNotice({ text: r.data.error || 'Could not remove document.', error: true }); return; }
    setDocuments(list => list.filter(d => d.id !== id));
    setNotice({ text: 'Document removed.', error: false });
    await load();
  }

  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-[min(1100px,calc(100%-28px))] pb-16 pt-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Tagline>Account centre</Tagline>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-[-.05em]">Your profile</h1>
          <p className="mt-1 text-sm text-muted">Edit your personal information, manage preferences and submit identity documents.</p>
        </div>
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" />Back to home</Button>
      </div>
      {loading ? <div className={panel + ' text-sm text-muted'}>Loading your account…</div> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_.9fr]">
          <div className="grid content-start gap-4">
            <section className={panel}>
              <div className="flex items-start justify-between gap-3">
                <div><h2 className="font-display text-xl font-extrabold">Personal information</h2><p className="mt-1 text-xs text-muted">Your email address remains your sign-in identity.</p></div>
                <span className={'rounded-full px-2.5 py-1 text-[10px] font-extrabold ' + (profile?.isVerified ? 'bg-[#e4f8c7] text-[#365314]' : 'bg-[#edf1f5] text-[#566274]')}>{profile?.isVerified ? 'Verified' : 'Not verified'}</span>
              </div>
              <form onSubmit={saveProfile} className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Full name" htmlFor="profileName"><input id="profileName" className={inputCls} required minLength={2} maxLength={120} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
                <Field label="Email address" htmlFor="profileEmail"><input id="profileEmail" className={inputCls} readOnly value={profile?.email || user?.email || ''} /></Field>
                <Field label="Phone number" htmlFor="profilePhone"><input id="profilePhone" type="tel" required className={inputCls} maxLength={40} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+234…" /></Field>
                <Field label="Location" htmlFor="profileLocation"><input id="profileLocation" required className={inputCls} maxLength={120} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="City, country" /></Field>
                <Field label="About you" htmlFor="profileBio" full><textarea id="profileBio" className={inputCls + ' min-h-24'} maxLength={1000} value={form.bio} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} placeholder="A short introduction." /></Field>
                <div className="sm:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button></div>
              </form>
            </section>
            <section className={panel}>
              <h2 className="font-display text-xl font-extrabold">Account settings</h2>
              <p className="mt-1 text-xs text-muted">Control message alerts and how your crew profile appears.</p>
              <div className="mt-4 grid gap-3">
                {[
                  ['message_popups', 'In-app message alerts', 'Show a pop-up when a new booking message arrives.'],
                  ['email_notifications', 'Email notifications', 'Preference for email updates when email delivery is enabled.'],
                  ['profile_visibility', 'Marketplace profile visibility', 'Allow your approved crew profile to appear in search results.']
                ].map(([key, label, description]) => (
                  <label key={key} className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line p-3">
                    <span><strong className="block text-sm">{label}</strong><span className="mt-0.5 block text-xs text-muted">{description}</span></span>
                    <input type="checkbox" className="mt-1 size-5 accent-[#6c9227]" checked={!!settings[key]} onChange={e => saveSetting(key, e.target.checked)} />
                  </label>
                ))}
              </div>
            </section>
            <section className={panel}>
              <h2 className="font-display text-xl font-extrabold">Password</h2>
              <form onSubmit={changePassword} className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Current password" htmlFor="pwCurrent"><input id="pwCurrent" type="password" className={inputCls} required maxLength={200} autoComplete="current-password" value={pw.current} onChange={e => setPw(v => ({ ...v, current: e.target.value }))} /></Field>
                <Field label="New password" htmlFor="pwNew"><input id="pwNew" type="password" className={inputCls} required minLength={10} maxLength={200} autoComplete="new-password" value={pw.next} onChange={e => setPw(v => ({ ...v, next: e.target.value }))} placeholder="10+ characters, letter and number" /></Field>
                <div className="sm:col-span-2"><Button type="submit">Change password</Button></div>
              </form>
            </section>
            <section className={panel + ' border-[#f3d1d1]'}>
              <h2 className="font-display text-xl font-extrabold text-[#a13232]">Delete account</h2>
              <p className="mt-1 text-xs text-muted">Your name, contact details and ID documents are erased and your crew profile is unlisted. Past bookings and invoices are kept for the other person and for tax records. You cannot delete while a booking is confirmed or in progress.</p>
              {!confirmDelete ? <div className="mt-3"><Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete my account</Button></div> : (
                <form onSubmit={deleteAccount} className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field label="Confirm with your password" htmlFor="delPw"><input id="delPw" type="password" className={inputCls} required autoComplete="current-password" value={delPw} onChange={e => setDelPw(e.target.value)} /></Field>
                  <Button type="submit">Permanently delete</Button>
                </form>
              )}
            </section>
          </div>
          <div className="grid content-start gap-4">
            <section className={panel}>
              <h2 className="font-display text-xl font-extrabold">Identity verification</h2>
              <p className="mt-1 text-xs text-muted">Submit one government-issued document for administrator review.</p>
              <div className="mt-3 rounded-xl bg-[#f5f7f3] p-3 text-xs">
                <strong>{profile?.isVerified ? 'Your account is verified' : 'Verification pending'}</strong>
                <p className="mt-1 text-muted">{profile?.isVerified ? 'Your approved identity document is on file.' : 'Your account will remain unverified until an administrator approves a submitted document.'}</p>
              </div>
              <form onSubmit={uploadId} className="mt-4 grid gap-3">
                <Field label="Document type" htmlFor="profileIdType">
                  <select id="profileIdType" className={inputCls} value={docType} onChange={e => setDocType(e.target.value)}>
                    {Object.entries(documentLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
                  </select>
                </Field>
                <Field label="Document file · PDF, JPG or PNG · max 5 MB" htmlFor="profileIdFile">
                  <input id="profileIdFile" type="file" accept="application/pdf,image/jpeg,image/png" className={inputCls} onChange={e => setFile(e.target.files?.[0] || null)} />
                </Field>
                {file && <p className="break-all text-xs text-muted">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
                <Button type="submit" disabled={uploading || !file}>{uploading ? 'Uploading securely…' : 'Upload ID for review'}</Button>
              </form>
              <p className="mt-3 text-[11px] leading-relaxed text-muted">Your document is encrypted before storage. Only an authorised administrator can retrieve it for verification. Upload only your own document.</p>
              <div className="mt-4 border-t border-line pt-3">
                <h3 className="mb-2 text-sm font-extrabold">Submitted documents</h3>
                {!documents.length ? <p className="text-xs text-muted">No identity documents uploaded yet.</p> : (
                  <div className="grid gap-2">
                    {documents.map(d => (
                      <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
                        <div className="min-w-0"><strong className="block text-xs">{documentLabels[d.document_type] || 'Identity document'}</strong><span className="block break-all text-[11px] text-muted">{d.original_name} · {new Date(d.created_at).toLocaleDateString()}</span><span className={'mt-1 inline-block rounded-full px-2 py-1 text-[10px] font-bold ' + (reviewStyles[d.review_status] || reviewStyles.pending)}>{d.review_status}</span>{d.review_note && <p className="mt-1 text-[11px] text-muted">{d.review_note}</p>}</div>
                        <Button size="sm" variant="ghost" onClick={() => removeDocument(d.id)}>Remove</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            <section className={panel}>
              <h2 className="font-display text-lg font-extrabold">Account information</h2>
              <div className="mt-2 flex justify-between text-xs"><span className="text-muted">Account type</span><strong className="capitalize">{profile?.accountType || user?.accountType || 'client'}</strong></div>
              <div className="mt-2 flex justify-between text-xs"><span className="text-muted">Account status</span><strong>{profile?.accountStatus || user?.accountStatus || 'active'}</strong></div>
              <p className="mt-3 text-[11px] text-muted">You can switch between Hiring and Crew using the mode selector in the navigation bar.</p>
            </section>
          </div>
        </div>
      )}
      <div role="status" className={'mt-4 text-sm font-semibold ' + (notice.error ? 'text-[#b42318]' : 'text-[#365314]')}>{notice.text}</div>
    </motion.section>
  );
}

const OPEN_STATES = ['awaiting_review', 'pending', 'counter_pending', 'confirmed'];
const day = d => String(d).slice(0, 10);
const statusStyle = { pending: 'bg-[#fff1d7] text-[#8b5c09]', accepted: 'bg-[#e3f4d3] text-[#3f6b12]', declined: 'bg-[#fde4e4] text-[#9b2c2c]', superseded: 'bg-[#eef1f4] text-[#64748b]' };

const Receipt = ({ seen }) => <span className={'mt-0.5 block text-[10px] font-bold ' + (seen ? 'text-[#2f7d4f]' : 'text-muted')} aria-label={seen ? 'Seen' : 'Sent'}>{seen ? '✓✓ Seen' : '✓ Sent'}</span>;

function PayPrompt({ thread }) {
  if (thread.payment_status === 'paid' || thread.payment_status === 'refunded' || !['confirmed', 'in_progress'].includes(thread.status)) return null;
  const client = thread.my_role === 'client';
  return (
    <div role="status" className="border-t border-line bg-[#fff8e6] px-4 py-2.5 text-xs leading-relaxed text-[#6b4e07]">
      <p className="font-extrabold uppercase tracking-[.1em]">Booking accepted · payment pending</p>
      <p className="mt-0.5 text-sm">{client ? 'Next step: proceed to payment to confirm this booking. Contact details are shared once payment is received.' : 'Waiting for the client to pay. The booking is confirmed and contact details are shared once payment is received.'}</p>
    </div>
  );
}

function ContactCard({ thread }) {
  const [c, setC] = useState(null);
  useEffect(() => { setC(null); if (thread.payment_status !== 'paid' || !['confirmed', 'in_progress', 'completion_review', 'completed'].includes(thread.status)) return; let live = true; http('/api/bookings/' + thread.id + '/contact').then(r => live && r.ok && setC(r.data)).catch(() => {}); return () => { live = false; }; }, [thread.id, thread.status, thread.payment_status]);
  if (!c?.available) return null;
  return (
    <div className="border-t border-line bg-lime-soft/60 px-4 py-2.5 text-xs">
      <p className="font-extrabold uppercase tracking-[.1em] text-[#4d6b14]">Payment received · contact details</p>
      <p className="mt-1 break-words text-sm"><strong>{c.name}</strong>{c.phone ? <> · <a className="font-bold underline" href={'tel:' + c.phone.replace(/[^+\d]/g, '')}>{c.phone}</a></> : <span className="text-muted"> · no phone number added yet, ask in the chat</span>}{c.email && <> · <a className="underline" href={'mailto:' + c.email}>{c.email}</a></>}</p>
      <p className="mt-0.5 text-muted">Chat messages still hide numbers. Keep payments inside the app.</p>
    </div>
  );
}

function ActionBar({ thread, busy, panel, setPanel, onComplete, onInvoice, onPay, groupDue, onPayGroup }) {
  const [showClient, setShowClient] = useState(false);
  const role = thread.my_role, st = thread.status, paid = thread.payment_status === 'paid';
  const started = day(thread.start_date) <= new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const items = [];
  if (role === 'client' && ['awaiting_review', 'pending', 'counter_pending'].includes(st)) items.push(['Withdraw request', () => setPanel('cancel'), 'cancel']);
  if (role === 'crew' && OPEN_STATES.includes(st)) items.push(['Cancel booking', () => setPanel('cancel'), 'cancel']);
  if (role === 'client' && !paid && thread.payment_status !== 'refunded' && ['confirmed', 'in_progress'].includes(st)) items.push(['Pay now ' + naira(thread.client_total), onPay, 'pay', true]);
  if (groupDue && groupDue.count > 1 && role === 'client' && !paid && ['confirmed', 'in_progress'].includes(st)) items.push(['Pay whole group ' + naira(groupDue.total) + ' (' + groupDue.count + ')', onPayGroup, 'pay', true]);
  if (role === 'client' && paid && ['confirmed', 'in_progress', 'completion_review'].includes(st) && started) items.push(['Job is done', onComplete, null, true]);
  if (['confirmed', 'in_progress', 'completed'].includes(st)) items.push(['Report a problem', () => setPanel('dispute'), 'dispute']);
  if (role === 'crew') items.push(['Client profile', () => setShowClient(true), 'clientprofile']);
  if (st === 'completed' && paid && !Number(thread.review_count)) items.push(['Leave a review', () => setPanel('review'), 'review', true]);
  if (paid && role === 'client') items.push(['Invoice', onInvoice, 'invoice']);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-line bg-[#fafbfa] px-4 py-2">
      {showClient && <ClientProfileModal bookingId={thread.id} onClose={() => setShowClient(false)} />}
      {items.map(([label, fn, key, primary]) => <Button key={label} size="sm" variant={primary ? 'primary' : 'ghost'} disabled={busy} aria-pressed={key ? panel === key : undefined} onClick={fn}>{key === 'invoice' && <FileText className="size-4" aria-hidden="true" />}{key === 'pay' && <CreditCard className="size-4" aria-hidden="true" />}{label}</Button>)}
    </div>
  );
}

function OfferCard({ message, thread, busy, onRespond }) {
  const o = message.offer || {};
  const mineRole = thread.my_role;
  const proposedByMe = o.proposed_by === mineRole;
  const title = message.kind === 'request' ? 'Booking request' : 'Proposed change';
  return (
    <div className={'w-full max-w-[88%] rounded-2xl border bg-white p-3.5 text-sm shadow-sm ' + (proposedByMe ? 'ml-auto border-ink/20' : 'mr-auto border-line')}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-[#566274]"><CalendarClock className="size-3.5" aria-hidden="true" />{title}</span>
        <span className={'rounded-full px-2 py-0.5 text-[10px] font-extrabold capitalize ' + (statusStyle[o.status] || statusStyle.pending)}>{o.status === 'superseded' ? 'replaced' : o.status}</span>
      </div>
      {message.masked_content && <p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{message.masked_content}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-[#f5f7f3] p-3 text-xs">
        <dt className="text-muted">{o.schedule_kind === 'delivery' ? 'Deliver by' : 'Dates'}</dt><dd className="text-right font-bold">{day(o.start_date)}{o.schedule_kind !== 'delivery' && o.end_date !== o.start_date ? ' to ' + day(o.end_date) : ''}</dd>
        {o.booking_unit === 'project' ? null : <><dt className="text-muted">{o.booking_unit === 'hour' ? 'Hours' : 'Length'}</dt><dd className="text-right font-bold">{o.booking_unit === 'half' ? 'Half day' : o.booking_unit === 'hour' ? o.quantity + (Number(o.quantity) === 1 ? ' hour' : ' hours') : o.days + (o.days === 1 ? ' day' : ' days')}</dd></>}
        <dt className="text-muted">{o.booking_unit === 'project' ? 'Project fee' : o.booking_unit === 'hour' ? 'Hourly rate' : 'Daily rate'}</dt><dd className="text-right font-bold">{naira(o.daily_rate)}</dd>
        {(() => {
          const base = Number(o.base != null ? o.base : Math.round(Number(o.daily_rate || 0) * Number(o.days || 1)));
          return mineRole === 'crew' ? (<>
            <dt className="text-muted">Booking value</dt><dd className="text-right font-bold">{naira(base)}</dd>
            <dt className="text-muted">Platform commission (10%)</dt><dd className="text-right font-bold">−{naira(base - Number(o.crew_net || 0))}</dd>
            <dt className="border-t border-line pt-1.5 font-extrabold">You receive</dt><dd className="border-t border-line pt-1.5 text-right font-extrabold">{naira(o.crew_net)}</dd>
          </>) : (<>
            <dt className="text-muted">Subtotal</dt><dd className="text-right font-bold">{naira(base)}</dd>
            <dt className="text-muted">Service fee (10%)</dt><dd className="text-right font-bold">+{naira(Number(o.client_total || 0) - base)}</dd>
            <dt className="border-t border-line pt-1.5 font-extrabold">You pay</dt><dd className="border-t border-line pt-1.5 text-right font-extrabold">{naira(o.client_total)}</dd>
          </>);
        })()}
      </dl>
      {o.status === 'pending' && !proposedByMe && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => onRespond(message.id, 'accepted')}><Check className="size-4" aria-hidden="true" />Accept</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRespond(message.id, 'declined')}><X className="size-4" aria-hidden="true" />Decline</Button>
        </div>
      )}
      {o.status === 'pending' && proposedByMe && <p className="mt-2 text-[11px] text-muted">Waiting for the other person to answer.</p>}
    </div>
  );
}

export function MessageInbox({ open, onClose, onRead, user, initialBookingId }) {
  const [proView, setProView] = useState(null);
  async function viewCrew(id) {
    const r = await http('/api/professionals').catch(() => ({ ok: false, data: {} }));
    const p = (r.data.professionals || []).find(x => Number(x.id) === Number(id));
    if (!p) { setError('This crew profile is not listed right now.'); return; }
    setProView({ id: Number(p.id), name: p.name, role: p.role, category: p.category, location: p.location, photo: p.photo || '', rate: Number(p.rate), rate_unit: p.rate_unit || 'day', desc: p.desc, skills: Array.isArray(p.skills) ? p.skills : [], cover: 'linear-gradient(135deg,#2a4f6b,#172337)', symbol: (p.name || '?')[0] });
  }
  const [threads, setThreads] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [propose, setPropose] = useState(null);
  const [panel, setPanel] = useState(null); // 'cancel' | 'dispute' | 'review' | 'invoice'
  const [reason, setReason] = useState('');
  const [stars, setStars] = useState(5);
  const [invoice, setInvoice] = useState(null);
  const [note, setNote] = useState('');
  const current = selected ? (threads.find(t => Number(t.id) === Number(selected.id)) || selected) : null;

  const loadThreads = useCallback(async () => {
    const r = await http('/api/inbox').catch(() => ({ ok: false, data: {} }));
    if (r.ok) setThreads(r.data.conversations || []);
    else setError(r.data.error || 'Could not load your messages.');
  }, []);

  const markRead = useCallback(async id => {
    await postJSON('/api/inbox/' + id + '/read', {}).catch(() => null);
    onRead?.();
  }, [onRead]);

  const openThread = useCallback(async thread => {
    setSelected(thread);
    setPropose(null);
    setDraft('');
    setError('');
    const r = await http('/api/bookings/' + thread.id + '/messages').catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { setError(r.data.error || 'Could not open this conversation.'); return; }
    setMessages(r.data || []);
    await markRead(thread.id);
    await loadThreads();
  }, [loadThreads, markRead]);

  useEffect(() => {
    if (!open) return;
    // Keep the page behind the inbox stationary, especially on iOS Safari.
    const scrollY = window.scrollY;
    const body = document.body;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    setSelected(null);
    setMessages([]);
    loadThreads();
    const stream = new EventSource('/api/messages/stream');
    stream.onmessage = () => loadThreads();
    return () => {
      stream.close();
      Object.assign(body.style, previous);
      window.scrollTo(0, scrollY);
    };
  }, [open, loadThreads]);

  useEffect(() => {
    if (!open || !initialBookingId || !threads.length) return;
    const thread = threads.find(t => Number(t.id) === Number(initialBookingId));
    if (thread && Number(selected?.id) !== Number(thread.id)) openThread(thread);
  }, [open, initialBookingId, threads, selected?.id, openThread]);

  useEffect(() => {
    if (!open || !selected?.id) return;
    const stream = new EventSource('/api/bookings/' + selected.id + '/messages/stream');
    stream.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message._read) { setMessages(list => list.map(m => message.ids.includes(Number(m.id)) && Number(m.sender_user_id) !== Number(message.reader) ? { ...m, read_by_other: true } : m)); return; }
        setMessages(list => list.some(m => Number(m.id) === Number(message.id)) ? list.map(m => Number(m.id) === Number(message.id) ? message : m) : [...list, message]);
        markRead(selected.id);
        loadThreads();
      } catch {}
    };
    return () => stream.close();
  }, [open, selected?.id, markRead, loadThreads]);

  function openPropose() {
    if (!current) return;
    setNote('');
    setPropose({ unit: current.booking_unit === 'half' ? 'half' : 'full', start: day(current.start_date), end: day(current.end_date), rate: String(Number(current.daily_rate || 0) || ''), qty: String(Number(current.quantity || '') || ''), kind: current.schedule_kind === 'delivery' ? 'delivery' : 'calendar' });
  }
  async function sendProposal(e) {
    e.preventDefault();
    if (!current || !propose || busy) return;
    setBusy(true); setError('');
    const body = { ...proposalBody(propose, current.rate_unit || 'day'), note };
    if (current.my_role === 'crew' && propose.rate) body.dailyRate = Number(propose.rate);
    const r = await postJSON('/api/bookings/' + current.id + '/offers', body).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { setError(r.data.error || 'Could not send your proposal.'); return; }
    setMessages(list => list.some(m => Number(m.id) === Number(r.data.message.id)) ? list : [...list, r.data.message]);
    setPropose(null); setNote('');
    await loadThreads();
  }
  async function refreshThread() {
    const fresh = await http('/api/bookings/' + current.id + '/messages').catch(() => ({ ok: false, data: [] }));
    if (fresh.ok) setMessages(fresh.data || []);
    await loadThreads();
  }
  async function runAction(request) {
    if (!current || busy) return;
    setBusy(true); setError('');
    const r = await request().catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { setError(r.data.error || 'That did not work. Please try again.'); return false; }
    setPanel(null); setReason(''); setStars(5);
    await refreshThread();
    return true;
  }
  const cancelBooking = () => runAction(() => postJSON('/api/bookings/' + current.id + '/cancel', { reason }));
  const markComplete = () => window.confirm('Confirm the job was done? This lets the crew member be paid and lets you leave a review.') && runAction(() => postJSON('/api/bookings/' + current.id + '/complete', {}));
  async function payNow() {
    if (busy) return;
    setBusy(true); setError('');
    const r = await postJSON('/api/payments/initialize', { booking_id: current.id }).catch(() => ({ ok: false, data: {} }));
    if (r.ok && r.data.checkout_url) { window.location.assign(r.data.checkout_url); return; }
    setError(r.data.error || 'Could not start the payment. Please try again.');
    setBusy(false);
  }
  const groupDue = (() => {
    if (!current || !current.group_ref || current.my_role !== 'client') return null;
    const due = threads.filter(t => t.group_ref === current.group_ref && t.my_role === 'client' && t.payment_status !== 'paid' && t.payment_status !== 'refunded' && ['confirmed', 'in_progress'].includes(t.status));
    return { count: due.length, total: due.reduce((n, t) => n + Number(t.client_total || 0), 0) };
  })();
  async function payGroup() {
    if (busy) return;
    setBusy(true); setError('');
    const r = await postJSON('/api/payments/initialize-group', { group_ref: current.group_ref }).catch(() => ({ ok: false, data: {} }));
    if (r.ok && r.data.checkout_url) { window.location.assign(r.data.checkout_url); return; }
    setError(r.data.error || 'Could not start the payment. Please try again.');
    setBusy(false);
  }
  const reportProblem = () => runAction(() => postJSON('/api/disputes', { booking_id: current.id, reason }));
  const sendReview = () => runAction(() => postJSON('/api/reviews', { booking_id: current.id, rating: stars, comment: reason }));
  async function showInvoice() {
    setError('');
    const r = await http('/api/invoices/' + current.id).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { setError(r.data.error || 'No invoice yet. It is created once payment is confirmed.'); return; }
    setInvoice(r.data); setPanel('invoice');
  }
  async function respondToOffer(messageId, response) {
    if (!current || busy) return;
    setBusy(true); setError('');
    const r = await postJSON('/api/bookings/' + current.id + '/offers/' + messageId + '/respond', { response }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) setError(r.data.error || 'Could not send your answer.');
    const fresh = await http('/api/bookings/' + current.id + '/messages').catch(() => ({ ok: false, data: [] }));
    if (fresh.ok) setMessages(fresh.data || []);
    setBusy(false);
    await loadThreads();
  }

  async function send(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !selected || busy) return;
    setBusy(true);
    const r = await postJSON('/api/bookings/' + selected.id + '/messages', { content }).catch(() => ({ ok: false, data: {} }));
    setBusy(false);
    if (!r.ok) { setError(r.data.error || 'Could not send message.'); return; }
    setMessages(list => list.some(m => Number(m.id) === Number(r.data.id)) ? list : [...list, r.data]);
    setDraft('');
    setError('');
    await loadThreads();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex items-stretch justify-center overflow-hidden bg-[#0b142280] backdrop-blur-sm sm:items-center sm:p-3" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
          <motion.section initial={{ y: 24, opacity: 0, scale: .98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 16, opacity: 0 }} className="flex h-[100dvh] max-h-[100dvh] w-full min-h-0 max-w-5xl flex-col overflow-hidden rounded-none bg-white shadow-2xl sm:h-[90dvh] sm:max-h-[90dvh] sm:rounded-2xl">
            <header className={'items-center justify-between border-b border-line px-4 py-3 sm:px-5 ' + (selected ? 'hidden md:flex' : 'flex')}>
              <div><Tagline>Account inbox</Tagline><h2 className="font-display text-xl font-extrabold">Messages</h2></div>
              <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </header>
            <div className="grid min-h-0 flex-1 grid-rows-1 overflow-hidden md:grid-cols-[300px_minmax(0,1fr)]">
              <aside className={'min-h-0 overflow-y-auto overscroll-contain border-line [touch-action:pan-y] [-webkit-overflow-scrolling:touch] md:block md:border-r ' + (selected ? 'hidden' : 'block')}>
                {!threads.length ? <p className="p-5 text-xs text-muted">No booking conversations yet.</p> : threads.map(thread => (
                  <button key={thread.id} type="button" onClick={() => openThread(thread)} className={'block w-full border-b border-line p-4 text-left transition hover:bg-[#f7f9f2] ' + (selected?.id === thread.id ? 'bg-[#f1f5e9]' : '')}>
                    <div className="flex items-center justify-between gap-2"><strong className="text-sm">{thread.my_role === 'client' ? (thread.professional_name || 'Crew member') : (thread.client_name || 'Client')}</strong>{Number(thread.unread_count) > 0 && <span className="rounded-full bg-lime px-2 py-0.5 text-[10px] font-extrabold">{thread.unread_count}</span>}</div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted">{thread.last_message || thread.project_type || 'Booking conversation'}</p>
                    <span className="mt-1 block text-[10px] text-muted">{thread.reference}{thread.group_title ? ' · Group: ' + thread.group_title : ''}</span>
                  </button>
                ))}
              </aside>
              <section className={'min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex ' + (selected ? 'flex' : 'hidden')}>
                {!selected ? <div className="grid flex-1 place-items-center p-6 text-sm text-muted">Choose a booking conversation.</div> : (
                  <>
                    <div className="flex items-center justify-between border-b border-line bg-white px-2 py-1.5 md:hidden">
                      <button type="button" onClick={() => setSelected(null)} className="rounded-lg px-2.5 py-2 text-sm font-extrabold text-ink active:bg-[#edf1f5]">← Messages</button>
                      <button type="button" onClick={onClose} className="rounded-lg px-2.5 py-2 text-sm font-bold text-muted active:bg-[#edf1f5]">Close</button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3">
                      <div>{current.my_role === 'client' && current.professional_id ? <button type="button" onClick={() => viewCrew(current.professional_id)} className="text-sm font-bold underline decoration-dotted underline-offset-2 hover:text-[#4d6f12]" title="View profile and portfolio">{current.professional_name}</button> : <strong className="text-sm">{current.my_role === 'client' ? current.professional_name : current.client_name}</strong>}{current.my_role === 'client' && current.professional_id && <button type="button" onClick={() => viewCrew(current.professional_id)} className="ml-2 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold hover:border-ink/30">View profile</button>}<span className="ml-2 text-[11px] text-muted">{current.reference}{current.group_title ? ' · Group: ' + current.group_title : ''}</span></div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted">{current.schedule_kind === 'delivery' ? 'Deliver by ' : ''}{day(current.start_date)}{current.schedule_kind !== 'delivery' && day(current.end_date) !== day(current.start_date) ? ' to ' + day(current.end_date) : ''}{current.booking_unit === 'half' ? ' · half day' : current.booking_unit === 'hour' ? ' · ' + Number(current.quantity) + ' hr' : current.booking_unit === 'project' ? ' · flat fee' : ''}</span>
                        <strong>{naira(current.my_role === 'crew' ? current.crew_net : current.client_total)}</strong>
                        <span className="rounded-full bg-[#eef1f4] px-2 py-0.5 text-[10px] font-extrabold capitalize text-[#445468]">{String(current.status).replaceAll('_', ' ')}</span>
                        {OPEN_STATES.includes(current.status) && current.payment_status !== 'paid' && <Button size="sm" variant="ghost" onClick={openPropose}><CalendarClock className="size-4" aria-hidden="true" />Change dates or price</Button>}
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain bg-[#f7f9f6] p-4 [touch-action:pan-y] [-webkit-overflow-scrolling:touch]">
                      {messages.map(message => {
                        if (message.sender_type === 'admin') return <div key={message.id} className="mx-auto w-full max-w-[92%] rounded-2xl border border-lime-deep/40 bg-lime-soft p-3 text-sm"><span className="mb-1 flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[.08em] text-[#4d6b14]">Support team · official</span><p className="whitespace-pre-wrap break-words text-ink">{message.masked_content}</p></div>;
                        if (message.kind === 'system') return <p key={message.id} className="mx-auto w-fit max-w-[90%] rounded-full bg-[#e8ecef] px-3 py-1 text-center text-[11px] text-[#445468]">{message.masked_content}</p>;
                        if (message.kind === 'request' || message.kind === 'offer') return <div key={message.id} className="flex flex-col"><span className={'mb-0.5 text-[10px] text-muted ' + (message.offer?.proposed_by === current.my_role ? 'text-right' : '')}>{message.offer?.proposed_by === current.my_role ? 'You' : message.sender_name}</span><OfferCard message={message} thread={current} busy={busy} onRespond={respondToOffer} />{message.offer?.proposed_by === current.my_role && <div className="text-right"><Receipt seen={message.read_by_other} /></div>}</div>;
                        const mine = message.sender_user_id ? Number(message.sender_user_id) === Number(user?.id) : (message.sender_type === selected.my_role && message.sender_name === user?.name);
                        return <div key={message.id} className={'flex flex-col ' + (mine ? 'items-end' : 'items-start')}><span className="mb-0.5 text-[10px] text-muted">{mine ? 'You' : message.sender_name}</span><p className={'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ' + (mine ? 'bg-ink text-white' : 'border border-line bg-white')}>{message.masked_content}</p>{mine && <Receipt seen={message.read_by_other} />}</div>;
                      })}
                      {!messages.length && <p className="p-4 text-center text-xs text-muted">No messages yet. Start the conversation.</p>}
                    </div>
                    <PayPrompt thread={current} />
                    <ContactCard thread={current} />
                    <ActionBar thread={current} busy={busy} panel={panel} setPanel={setPanel} onComplete={markComplete} onInvoice={showInvoice} onPay={payNow} groupDue={groupDue} onPayGroup={payGroup} />
                    {panel && panel !== 'invoice' && (
                      <form onSubmit={e => { e.preventDefault(); ({ cancel: cancelBooking, dispute: reportProblem, review: sendReview })[panel](); }} className="grid gap-2.5 border-t border-line bg-white p-3.5">
                        <div className="flex items-center justify-between"><strong className="text-sm">{{ cancel: current.my_role === 'crew' ? 'Cancel this booking' : 'Withdraw this request', dispute: 'Report a problem', review: 'Leave a review' }[panel]}</strong><button type="button" className="text-xs text-muted underline" onClick={() => setPanel(null)}>Close</button></div>
                        {panel === 'review' && <div role="radiogroup" aria-label="Rating" className="flex gap-1">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={n + ' star' + (n > 1 ? 's' : '')} onClick={() => setStars(n)}><Star className={'size-6 ' + (n <= stars ? 'fill-[#f5b301] text-[#f5b301]' : 'text-line')} aria-hidden="true" /></button>)}</div>}
                        {(panel !== 'cancel' || current.my_role === 'crew') && <textarea className={inputCls + ' min-h-20'} value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} required={panel !== 'review'} placeholder={panel === 'cancel' ? 'Tell the client why (they will see this)' : panel === 'dispute' ? 'What went wrong? Support will review it.' : 'Optional: how was it?'} />}
                        <Button type="submit" variant={panel === 'review' ? 'primary' : 'dark'} disabled={busy}>{busy ? 'Please wait…' : { cancel: current.my_role === 'crew' ? 'Cancel booking' : 'Withdraw request', dispute: 'Send report', review: 'Post review' }[panel]}</Button>
                      </form>
                    )}
                    {panel === 'invoice' && invoice && (
                      <div className="grid gap-1.5 border-t border-line bg-white p-3.5 text-xs">
                        <div className="flex items-center justify-between"><strong className="text-sm">Invoice {invoice.invoice_number}</strong><button type="button" className="text-xs text-muted underline" onClick={() => setPanel(null)}>Close</button></div>
                        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span>{naira(invoice.subtotal)}</span></div>
                        <div className="flex justify-between"><span className="text-muted">VAT ({Number(invoice.vat_rate)}%)</span><span>{naira(invoice.vat_amount)}</span></div>
                        <div className="flex justify-between font-extrabold"><span>Total</span><span>{naira(invoice.total_amount)}</span></div>
                        {invoice.supplier_tin && <div className="text-muted">Supplier TIN: {invoice.supplier_tin}</div>}
                        <button type="button" className="w-fit text-xs font-bold underline" onClick={() => window.print()}>Print</button>
                      </div>
                    )}
                    {propose && (
                      <form onSubmit={sendProposal} className="grid gap-3 border-t border-line bg-white p-3.5">
                        <div className="flex items-center justify-between"><strong className="text-sm">Propose a change</strong><button type="button" className="text-xs text-muted underline" onClick={() => setPropose(null)}>Cancel</button></div>
                        <ProposalFields value={propose} onChange={setPropose} canEditRate viewer={current.my_role} rateUnit={current.rate_unit || 'day'} baseRate={Number(current.daily_rate || 0)} />
                        <input className={inputCls} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} placeholder="Add a note (optional)" />
                        <Button type="submit" disabled={busy || !propose.start}>{busy ? 'Sending…' : 'Send proposal'}</Button>
                      </form>
                    )}
                    <p className="border-t border-line bg-[#fff8e6] px-3 py-1.5 text-[11px] text-[#6b4e07]">Beware of scams: never pay, send deposits or share bank details outside the app. Support can review this chat if a problem is reported.</p>
                    <form onSubmit={send} className="flex gap-2 border-t border-line bg-white p-3 pb-[max(12px,env(safe-area-inset-bottom))]"><input className={inputCls + ' flex-1'} value={draft} onChange={e => setDraft(e.target.value)} maxLength={2000} placeholder="Write a message…" /><Button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</Button></form>
                  </>
                )}
              </section>
            </div>
            {error && <p role="alert" className="border-t border-rose-100 px-4 py-2 text-xs text-rose-700">{error}</p>}
          </motion.section>
        </motion.div>
      )}
      {proView && <ProfileDrawer key="pv" pro={proView} onClose={() => setProView(null)} />}
    </AnimatePresence>
  );
}
