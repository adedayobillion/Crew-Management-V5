import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { AuthModal, BookingModal, JoinModal, LegalModal } from './modals.jsx';
import { Banner, COVERS, CrewDashboard, Dashboard, Discover, Footer, Hero, How, Nav, SYMBOLS, Trust } from './sections.jsx';
import { ScrollProgress, ToastProvider, useToast } from './ui.jsx';
import { http, postJSON } from './lib.js';

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

  useEffect(() => {
    http('/api/professionals').then(({ ok, data }) => {
      if (!ok) throw 0;
      setPros((data.professionals || []).map((p, i) => ({ id: Number(p.id), name: p.name, role: p.role, category: p.category, location: p.location, rate: Number(p.rate), credits: p.credits, desc: p.desc, skills: Array.isArray(p.skills) ? p.skills : [], cover: COVERS[i % 6], symbol: SYMBOLS[i % 6] })));
    }).catch(() => setPros([])).finally(() => setLoading(false));
    http('/api/auth/me').then(({ data }) => setUser(data.user || null)).catch(() => setUser(null));
  }, []);

  const closeAuth = useCallback(() => setAuth(a => ({ ...a, open: false })), []);
  const openAuth = (mode = 'login', next = null, role = null) => setAuth({ open: true, mode, role, next });
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
      <Nav user={user} onLogin={() => openAuth('login')} onLogout={logout} onDashboard={openDashboard} onCrewDashboard={openCrewDashboard} onSwitch={switchMode} onHome={() => showPage('marketplace')} onJoin={openJoin} />
      <main>
        <AnimatePresence mode="wait">
          {page === 'marketplace' ? (
            <div key="m">
              <Hero filters={filters} setFilters={setFilters} onJoin={openJoin} />
              <Discover pros={pros} loading={loading} filters={filters} setFilters={setFilters} saved={saved} onSave={toggleSave} onBook={openBooking} />
              <How /><Trust /><Banner onJoin={openJoin} />
            </div>
          ) : page === 'crew' ? <CrewDashboard key="c" onBack={() => showPage('marketplace')} onJoin={openJoin} toast={toast} />
          : <Dashboard key="d" onBack={() => showPage('marketplace')} onJoin={openJoin} />}
        </AnimatePresence>
      </main>
      <Footer openLegal={setLegal} />
      <AuthModal open={auth.open} mode={auth.mode} setMode={m => setAuth(a => ({ ...a, mode: m }))} defaultRole={auth.role} onClose={closeAuth} onSuccess={onAuthed} openLegal={setLegal} />
      <BookingModal pro={bookingPro} user={user} onClose={() => setBookingPro(null)} onNeedAuth={pro => { setBookingPro(null); openAuth('login', () => setBookingPro(pro)); }}
        onSent={b => { setBookingPro(null); toast('Booking request saved to the server. Reference: ' + b.reference + '. No payment has been taken.'); showPage('dashboard'); }} />
      <JoinModal open={joinOpen} user={user} onClose={() => setJoinOpen(false)} onNeedAuth={() => { setJoinOpen(false); openAuth('login', () => setJoinOpen(true), 'crew'); }}
        onDone={a => { setJoinOpen(false); toast('Crew application received for review. Application #' + a.id + '.'); }} />
      <LegalModal topic={legal} setTopic={setLegal} onClose={() => setLegal(null)} />
    </>
  );
}
export default function App() { return <ToastProvider><Shell /></ToastProvider>; }
