import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AuthModal, BookingModal, JoinModal, LegalModal, ResetModal } from './modals.jsx';
import { MessageInbox, ProfilePage } from './Account.jsx';
import { Banner, COVERS, CrewDashboard, Dashboard, Discover, Footer, Hero, How, Nav, SYMBOLS, Trust } from './sections.jsx';
import { ScrollProgress, ToastProvider, useToast } from './ui.jsx';
import { http, postJSON } from './lib.js';
import { Mail } from 'lucide-react';

function Shell() {
  const toast = useToast();
  const [user, setUser] = useState(null);
  const [pros, setPros] = useState([]); const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('marketplace');
  const [filters, setFilters] = useState({ q: '', category: '', location: '', sort: 'recommended' });
  const [saved, setSaved] = useState(new Set());
  const [auth, setAuth] = useState({ open: false, mode: 'login', role: null, next: null });
  const [bookingPro, setBookingPro] = useState(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [legal, setLegal] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxInitialId, setInboxInitialId] = useState(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [incomingMessage, setIncomingMessage] = useState(null);
  const [messagePopupsEnabled, setMessagePopupsEnabled] = useState(true);

  const refreshProfessionals = useCallback(async () => {
    const r = await http('/api/professionals').catch(() => ({ ok: false, data: {} }));
    if (!r.ok) return;
    setPros((r.data.professionals || []).map((p, i) => ({
      id: Number(p.id), name: p.name, role: p.role, category: p.category,
      location: p.location, rate: Number(p.rate), credits: p.credits, desc: p.desc, rating: p.rating == null ? null : Number(p.rating), reviewCount: Number(p.review_count || 0),
      skills: Array.isArray(p.skills) ? p.skills : [], cover: COVERS[i % 6], symbol: SYMBOLS[i % 6]
    })));
  }, []);

  const refreshUnread = useCallback(async () => {
    if (!user) { setUnreadMessages(0); return; }
    const r = await http('/api/inbox').catch(() => ({ ok: false, data: {} }));
    if (r.ok) setUnreadMessages((r.data.conversations || []).reduce((sum, c) => sum + Number(c.unread_count || 0), 0));
  }, [user?.id]);

  useEffect(() => {
    if (!user) {
      setUnreadMessages(0);
      setIncomingMessage(null);
      setMessagePopupsEnabled(true);
      return;
    }
    let active = true;
    http('/api/profile').then(r => {
      if (active && r.ok) setMessagePopupsEnabled(r.data.settings?.message_popups !== false);
    }).catch(() => {});
    refreshUnread();
    const stream = new EventSource('/api/messages/stream');
    stream.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!active) return;
      if (messagePopupsEnabled && !inboxOpen) setIncomingMessage(message);
      refreshUnread();
    };
    return () => { active = false; stream.close(); };
  }, [user?.id, messagePopupsEnabled, inboxOpen, refreshUnread]);

  // Links from emails: ?reset=<token>, ?verify=<token>, ?inbox=<booking id>
  const [resetToken, setResetToken] = useState('');
  const [wantInbox, setWantInbox] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const reset = q.get('reset'), verify = q.get('verify'), inbox = q.get('inbox');
    if (!reset && !verify && !inbox) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (reset) setResetToken(reset);
    if (inbox) setWantInbox(Number(inbox));
    if (verify) postJSON('/api/auth/verify-email', { token: verify }).then(r => {
      toast(r.ok ? 'Email confirmed. Thank you.' : (r.data.error || 'Could not confirm your email.'));
      if (r.ok) http('/api/auth/me').then(({ data }) => setUser(data.user || null)).catch(() => {});
    }).catch(() => toast('Could not confirm your email.'));
  }, []);
  useEffect(() => { if (wantInbox && user) { setInboxInitialId(wantInbox); setInboxOpen(true); setWantInbox(null); } }, [wantInbox, user]);

  // Returning from the hosted checkout: confirm with the server (it re-checks with the gateway) and open the chat.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const state = q.get('pay'), id = q.get('booking');
    if (!state || !id) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (state === 'cancelled') { toast('Payment cancelled. You can pay any time from the chat.'); return; }
    let tries = 0;
    const check = async () => {
      const r = await postJSON('/api/payments/verify', { booking_id: Number(id) }).catch(() => ({ ok: false, data: {} }));
      if (r.ok && r.data.status === 'verified') { toast('Payment received. Your booking is confirmed and paid.'); return; }
      if (++tries < 6) setTimeout(check, 4000); else toast('We are still waiting for the payment to clear. This will update on its own.');
    };
    check();
  }, []);

  useEffect(() => {
    refreshProfessionals().catch(() => setPros([])).finally(() => setLoading(false));
    http('/api/auth/me').then(({ data }) => setUser(data.user || null)).catch(() => setUser(null));
  }, [refreshProfessionals]);

  const closeAuth = useCallback(() => setAuth(a => ({ ...a, open: false })), []);
  const openAuth = (mode = 'login', next = null, role = null) => setAuth({ open: true, mode, role, next });
  const openInbox = bookingId => {
    if (!user) {
      openAuth('login', () => {
        setInboxInitialId(bookingId || null);
        setInboxOpen(true);
        setIncomingMessage(null);
      });
      return;
    }
    setInboxInitialId(bookingId || null);
    setInboxOpen(true);
    setIncomingMessage(null);
  };
  const openProfile = () => {
    if (!user) { openAuth('login', () => showPage('profile')); return; }
    showPage('profile');
  };
  const showPage = p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  // Switch between hiring and crew mode (one login, like Airbnb's guest/host toggle)
  async function ensureMode(mode, quiet = false) {
    if (user && user.accountType === mode) return true;
    const { ok, data } = await postJSON('/api/auth/switch-mode', { mode }).catch(() => ({ ok: false, data: {} }));
    if (!ok) { toast(data.error || 'Could not switch mode. Please try again.'); return false; }
    setUser(data.user);
    if (!quiet) toast(mode === 'crew' ? 'Switched to crew mode.' : 'Switched to hiring mode.');
    return true;
  }
  const switchMode = async mode => { if (await ensureMode(mode)) showPage(mode === 'crew' ? 'crew' : 'marketplace'); };
  const openDashboard = async () => {
    if (!user) return openAuth('login', () => showPage('dashboard'));
    if (await ensureMode('client')) showPage('dashboard');
  };
  const openCrewDashboard = async () => {
    if (!user) return openAuth('login', () => showPage('crew'));
    if (await ensureMode('crew')) showPage('crew');
  };
  const openBooking = async pro => {
    if (!user) { openAuth('login', () => setBookingPro(pro)); toast('Log in to request a booking.'); return; }
    if (await ensureMode('client')) setBookingPro(pro);
  };
  const openJoin = async () => {
    if (!user) { openAuth('register', () => setJoinOpen(true), 'crew'); toast('Create an account to apply to the crew network.'); return; }
    if (await ensureMode('crew')) setJoinOpen(true);
  };
  async function logout() {
    try { await postJSON('/api/auth/logout', {}); } finally { setUser(null); showPage('marketplace'); toast('You have been signed out.'); }
  }
  function onAuthed(u, mode) {
    setUser(u); closeAuth();
    toast(u.accountStatus === 'pending_review' ? 'Account created. An administrator must approve it before you can book or submit a crew application.' : (mode === 'register' ? 'Your account has been created.' : 'Welcome back.'));
    const next = auth.next;
    if (next) setTimeout(next, 250);
    else if (u.accountType === 'crew' && mode === 'register') setTimeout(() => toast('You are in crew mode. Choose “Join as crew” to submit your profile. You can switch back to hiring any time.'), 900);
  }
  const toggleSave = id => setSaved(s => { const n = new Set(s); const had = n.has(id); had ? n.delete(id) : n.add(id); toast(had ? 'Removed from shortlist.' : 'Saved to shortlist.'); return n; });

  return (
    <>
      <ScrollProgress />
      <Nav user={user} onLogin={() => openAuth('login')} onLogout={logout} onDashboard={openDashboard} onCrewDashboard={openCrewDashboard} onSwitch={switchMode} onHome={() => showPage('marketplace')} onJoin={openJoin} onProfile={openProfile} onMessages={() => openInbox()} unreadCount={unreadMessages} />
      {user && user.emailEnabled && user.emailVerified === false && (
        <div role="status" className="border-b border-[#f1dfae] bg-[#fff8e6] px-4 py-2 text-center text-xs font-semibold text-[#7a5a0b]">
          Please confirm your email address to book crew or accept bookings.{' '}
          <button type="button" className="underline" onClick={async () => { const r = await postJSON('/api/auth/resend-verification', {}).catch(() => ({ ok: false, data: {} })); toast(r.ok ? 'Confirmation email sent. Check your inbox.' : (r.data.error || 'Could not send the email.')); }}>Resend the email</button>
        </div>
      )}
      <main>
        <AnimatePresence mode="wait">
          {page === 'marketplace' ? (
            <div key="m">
              <Hero filters={filters} setFilters={setFilters} onJoin={openJoin} />
              <Discover pros={pros} loading={loading} filters={filters} setFilters={setFilters} saved={saved} onSave={toggleSave} onBook={openBooking} />
              <How /><Trust /><Banner onJoin={openJoin} />
            </div>
          ) : page === 'profile' ? <ProfilePage key="profile" user={user} onBack={() => showPage('marketplace')} onUserUpdated={profile => { setUser(profile); refreshProfessionals(); }} onSignedOut={() => { setUser(null); showPage('marketplace'); toast('Your account has been deleted.'); }} onSettingsUpdated={settings => { setMessagePopupsEnabled(settings.message_popups !== false); refreshProfessionals(); }} />
          : page === 'crew' ? <CrewDashboard key="c" onBack={() => showPage('marketplace')} onJoin={openJoin} toast={toast} user={user} onMessages={openInbox} />
          : <Dashboard key="d" onBack={() => showPage('marketplace')} onJoin={openJoin} toast={toast} user={user} onMessages={openInbox} />}
        </AnimatePresence>
      </main>
      <Footer openLegal={setLegal} />
      <ResetModal token={resetToken} onClose={() => setResetToken('')} onDone={() => { setResetToken(''); setUser(null); toast('Password updated. Please log in with your new password.'); openAuth('login'); }} />
      <AuthModal open={auth.open} mode={auth.mode} setMode={m => setAuth(a => ({ ...a, mode: m }))} defaultRole={auth.role} onClose={closeAuth} onSuccess={onAuthed} openLegal={setLegal} />
      <BookingModal pro={bookingPro} user={user} onClose={() => setBookingPro(null)} onNeedAuth={pro => { setBookingPro(null); openAuth('login', () => setBookingPro(pro)); }}
        onSent={b => { setBookingPro(null); toast('Request sent. Agree the details in the chat. Nothing is charged until it is accepted.'); openInbox(b.id); }} />
      <JoinModal open={joinOpen} user={user} onClose={() => setJoinOpen(false)} onNeedAuth={() => { setJoinOpen(false); openAuth('login', () => setJoinOpen(true), 'crew'); }}
        onDone={a => { setJoinOpen(false); toast('Crew application received for review. Application #' + a.id + '.'); }} />
      <LegalModal topic={legal} setTopic={setLegal} onClose={() => setLegal(null)} />
      <MessageInbox open={inboxOpen} onClose={() => setInboxOpen(false)} onRead={refreshUnread} user={user} initialBookingId={inboxInitialId} />
      <AnimatePresence>
        {incomingMessage && !inboxOpen && (
          <motion.div initial={{ opacity: 0, y: 18, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-5 right-4 z-[85] w-[min(380px,calc(100%-32px))] rounded-2xl border border-line bg-white p-4 shadow-2xl sm:right-6">
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => openInbox(incomingMessage.booking_id)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-2 text-xs font-extrabold text-[#5f7f22]"><span className="grid size-8 place-items-center rounded-full bg-lime-soft"><Mail className="size-4" aria-hidden="true" /></span>New message</span>
                <strong className="mt-2 block truncate text-sm">{incomingMessage.sender_name || 'New message'}</strong>
                <span className="mt-1 block line-clamp-2 text-xs text-muted">{incomingMessage.preview || 'You have a new booking message.'}</span>
                <span className="mt-2 block text-[11px] font-bold text-[#5f7f22]">Open conversation · {incomingMessage.reference || ''}</span>
              </button>
              <button type="button" aria-label="Dismiss notification" onClick={() => setIncomingMessage(null)} className="rounded-lg px-2 py-1 text-muted hover:bg-[#f1f3f5]">×</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
export default function App() { return <ToastProvider><Shell /></ToastProvider>; }
