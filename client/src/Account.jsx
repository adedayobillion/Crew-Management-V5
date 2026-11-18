import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, Tagline, inputCls } from './ui.jsx';
import { http, postJSON } from './lib.js';

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

export function ProfilePage({ user, onBack, onUserUpdated }) {
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
        <Button variant="ghost" onClick={onBack}>← Back to home</Button>
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
                <Field label="Phone number" htmlFor="profilePhone"><input id="profilePhone" className={inputCls} maxLength={40} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+234…" /></Field>
                <Field label="Location" htmlFor="profileLocation"><input id="profileLocation" className={inputCls} maxLength={120} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="City, country" /></Field>
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

export function MessageInbox({ open, onClose, onRead, user, initialBookingId }) {
  const [threads, setThreads] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    setSelected(null);
    setMessages([]);
    loadThreads();
    const stream = new EventSource('/api/messages/stream');
    stream.onmessage = () => loadThreads();
    return () => stream.close();
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
        setMessages(list => list.some(m => Number(m.id) === Number(message.id)) ? list : [...list, message]);
        markRead(selected.id);
        loadThreads();
      } catch {}
    };
    return () => stream.close();
  }, [open, selected?.id, markRead, loadThreads]);

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
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex items-center justify-center bg-[#0b142280] p-3 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
          <motion.section initial={{ y: 24, opacity: 0, scale: .98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 16, opacity: 0 }} className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
              <div><Tagline>Account inbox</Tagline><h2 className="font-display text-xl font-extrabold">Messages</h2></div>
              <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </header>
            <div className="grid min-h-0 flex-1 md:grid-cols-[300px_1fr]">
              <aside className="max-h-[32vh] overflow-y-auto border-b border-line md:max-h-none md:border-b-0 md:border-r">
                {!threads.length ? <p className="p-5 text-xs text-muted">No booking conversations yet.</p> : threads.map(thread => (
                  <button key={thread.id} type="button" onClick={() => openThread(thread)} className={'block w-full border-b border-line p-4 text-left transition hover:bg-[#f7f9f2] ' + (selected?.id === thread.id ? 'bg-[#f1f5e9]' : '')}>
                    <div className="flex items-center justify-between gap-2"><strong className="text-sm">{thread.my_role === 'client' ? (thread.professional_name || 'Crew member') : (thread.client_name || 'Client')}</strong>{Number(thread.unread_count) > 0 && <span className="rounded-full bg-lime px-2 py-0.5 text-[10px] font-extrabold">{thread.unread_count}</span>}</div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted">{thread.last_message || thread.project_type || 'Booking conversation'}</p>
                    <span className="mt-1 block text-[10px] text-muted">{thread.reference}</span>
                  </button>
                ))}
              </aside>
              <section className="flex min-h-0 flex-1 flex-col">
                {!selected ? <div className="grid flex-1 place-items-center p-6 text-sm text-muted">Choose a booking conversation.</div> : (
                  <>
                    <div className="border-b border-line px-4 py-3"><strong className="text-sm">{selected.my_role === 'client' ? selected.professional_name : selected.client_name}</strong><span className="ml-2 text-[11px] text-muted">{selected.reference}</span></div>
                    <div className="flex-1 space-y-2 overflow-y-auto bg-[#f7f9f6] p-4">
                      {messages.map(message => {
                        const mine = message.sender_user_id ? Number(message.sender_user_id) === Number(user?.id) : (message.sender_type === selected.my_role && message.sender_name === user?.name);
                        return <div key={message.id} className={'flex flex-col ' + (mine ? 'items-end' : 'items-start')}><span className="mb-0.5 text-[10px] text-muted">{mine ? 'You' : message.sender_name}</span><p className={'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ' + (mine ? 'bg-ink text-white' : 'border border-line bg-white')}>{message.masked_content}</p></div>;
                      })}
                      {!messages.length && <p className="p-4 text-center text-xs text-muted">No messages yet. Start the conversation.</p>}
                    </div>
                    <form onSubmit={send} className="flex gap-2 border-t border-line p-3"><input className={inputCls + ' flex-1'} value={draft} onChange={e => setDraft(e.target.value)} maxLength={2000} placeholder="Write a message…" /><Button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</Button></form>
                  </>
                )}
              </section>
            </div>
            {error && <p role="alert" className="border-t border-rose-100 px-4 py-2 text-xs text-rose-700">{error}</p>}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
