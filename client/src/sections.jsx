import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import CameraArt from './CameraArt.jsx';
import CrewListing from './CrewListing.jsx';
import { AnimatedNumber, Button, Field, Marquee, Reveal, SkeletonCard, SpotlightCard, Tagline, inputCls } from './ui.jsx';
import { cn, http, naira, postJSON } from './lib.js';
import { ArrowDownRight, Brush, ArrowLeft, ArrowLeftRight, ArrowUpRight, Camera, Clapperboard, Heart, Lightbulb, Mail, Menu, Mic, Scissors, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';

export const COVERS = ['linear-gradient(130deg,#263b4b,#607c87)', 'linear-gradient(130deg,#604c4b,#bc8d78)', 'linear-gradient(130deg,#324b40,#91a783)', 'linear-gradient(130deg,#343b58,#8290bb)', 'linear-gradient(130deg,#584c3d,#c4ad7a)', 'linear-gradient(130deg,#43394c,#9b7da8)'];
const S = { size: '1em', strokeWidth: 1.6, 'aria-hidden': true };
// One icon per category order used by CATEGORIES: Camera, Production, Editing, Lighting, Sound, Creative
export const SYMBOLS = [<Camera key="c" {...S} />, <Clapperboard key="p" {...S} />, <Scissors key="e" {...S} />, <Lightbulb key="l" {...S} />, <Mic key="s" {...S} />, <Sparkles key="r" {...S} />];
export const CATEGORIES = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];

/* ---------- Nav ---------- */
function ModeSwitch({ user, onSwitch, className }) {
  const opts = [['client', 'Hiring'], ['crew', 'Crew']];
  return (
    <div role="group" aria-label="Switch between hiring and crew mode" className={cn('flex rounded-full bg-[#edf1f5] p-0.5 text-[11px] font-extrabold', className)}>
      {opts.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={user.accountType === v} onClick={() => user.accountType !== v && onSwitch(v)}
          className={cn('flex-1 rounded-full px-3.5 py-1.5 transition-colors', user.accountType === v ? 'bg-ink text-white shadow-sm' : 'text-muted hover:text-ink')}>{l}</button>
      ))}
    </div>
  );
}

export function Nav({ user, onLogin, onLogout, onDashboard, onCrewDashboard, onSwitch, onHome, onJoin, onProfile, onMessages, onTools, onJobs, unreadCount = 0 }) {
  const [open, setOpen] = useState(false);
  const crewMode = !!user && user.accountType === 'crew';
  const workspace = crewMode ? onCrewDashboard : onDashboard;
  const workspaceLabel = crewMode ? 'My listings' : 'My bookings';
  const links = [['#discover', 'Find professionals'], ['#how', 'How it works'], ['#trust', 'Safe bookings'], ['#join', 'Join as crew'], ['#jobs', 'Job board'], ['#tools', 'Free call sheet']];
  const go = fn => e => { e.preventDefault(); setOpen(false); fn(); };
  return (
    <>
      <div className="bg-ink py-2 text-xs text-[#dfe6ed]"><div className="mx-auto flex w-[min(1200px,calc(100%-28px))] justify-between gap-3"><span>CREW MANAGEMENT AGENCY · NIGERIA</span><span className="hidden sm:block">Professional production crew. Clear bookings. One trusted platform.</span></div></div>
      <header className="sticky top-1.5 z-30 mx-auto mt-2.5 w-[min(1200px,calc(100%-28px))] sm:top-2.5">
        <div className="relative flex h-[60px] items-center justify-between gap-3 rounded-[17px] border border-white/80 bg-white/75 px-3.5 shadow-[0_10px_40px_#17233714,0_0_0_1px_#17233710] backdrop-blur-xl backdrop-saturate-150 sm:h-[66px] sm:rounded-[20px] sm:px-4">
          <a href="#" onClick={go(onHome)} className="group flex min-w-0 shrink items-center gap-2.5 whitespace-nowrap font-display font-extrabold tracking-[-.03em]">
            <motion.span whileHover={{ rotate: -10, scale: 1.08 }} transition={{ type: 'spring', stiffness: 400, damping: 14 }} className="grid size-9 place-items-center rounded-xl bg-lime text-lg shadow-[0_6px_16px_#8ebc4655,inset_0_1px_0_#fff9] sm:size-10">C</motion.span>
            <span className="min-w-0 truncate text-[11px] leading-tight max-[389px]:hidden sm:text-sm">CREW MANAGEMENT<small className="block text-[8px] font-extrabold tracking-[.16em] text-muted max-[430px]:hidden sm:text-[9px]">AGENCY · THE CREW MARKETPLACE</small></span>
          </a>
          <nav className="hidden gap-6 text-[13px] font-bold md:flex">
            {links.map(([h, l]) => (
              <a key={h} href={h} onClick={h === '#join' ? undefined : h === '#tools' ? e => { e.preventDefault(); onTools(); } : h === '#jobs' ? e => { e.preventDefault(); onJobs(); } : () => onHome()} className="group/l relative py-1.5 transition-colors hover:text-[#4d6f12]">{l}<span className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 rounded bg-lime-deep transition-transform duration-300 group-hover/l:scale-x-100" /></a>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {user && <ModeSwitch user={user} onSwitch={onSwitch} className="max-sm:hidden" />}
            <button type="button" onClick={onMessages} aria-label="Messages" title="Messages" className="relative grid size-9 place-items-center rounded-xl text-lg text-ink transition hover:bg-[#edf1f5]">
              <Mail className="size-5" strokeWidth={1.75} aria-hidden="true" />
              {unreadCount > 0 && <span className="absolute -right-0.5 -top-0.5 grid min-w-[17px] place-items-center rounded-full bg-[#d84b4b] px-1 text-[9px] font-extrabold leading-[17px] text-white">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </button>
            <button type="button" onClick={onProfile} aria-label="Profile" title="Profile" className="flex h-9 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-bold text-ink transition hover:bg-[#edf1f5]"><UserRound className="size-5" strokeWidth={1.75} aria-hidden="true" /><span className="hidden sm:inline">Profile</span></button>
            <Button size="sm" variant="ghost" onClick={user ? onLogout : onLogin}>{user ? 'Log out' : 'Log in'}</Button>
            <Button size="sm" className="max-[480px]:hidden" onClick={workspace}>{workspaceLabel}</Button>
            <button className="grid size-9 place-items-center rounded-lg text-xl md:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}</button>
          </div>
          <AnimatePresence>
            {open && (
              <motion.nav initial={{ opacity: 0, y: -10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                className="absolute inset-x-0 top-[calc(100%+8px)] flex flex-col gap-1 rounded-2xl border border-line bg-white p-3 text-sm font-bold shadow-soft md:hidden">
                {links.map(([h, l]) => <a key={h} href={h} onClick={h === '#tools' || h === '#jobs' ? e => { e.preventDefault(); setOpen(false); (h === '#jobs' ? onJobs : onTools)(); } : () => setOpen(false)} className="rounded-xl px-3 py-3 hover:bg-lime-soft">{l}</a>)}
                {user && <ModeSwitch user={user} onSwitch={m => { setOpen(false); onSwitch(m); }} className="mx-1 my-1 sm:hidden [&>button]:py-2.5" />}
                <button type="button" onClick={() => { setOpen(false); onProfile(); }} className="rounded-xl px-3 py-3 text-left hover:bg-lime-soft">My profile & settings</button>
                <button type="button" onClick={() => { setOpen(false); onMessages(); }} className="flex items-center justify-between rounded-xl px-3 py-3 text-left hover:bg-lime-soft"><span>Messages</span>{unreadCount > 0 && <span className="rounded-full bg-[#d84b4b] px-2 py-0.5 text-[10px] font-bold text-white">{unreadCount}</span>}</button>
                <button type="button" onClick={() => { setOpen(false); workspace(); }} className="rounded-xl bg-lime px-3 py-3 text-left min-[481px]:hidden">{workspaceLabel}</button>
              </motion.nav>
            )}
          </AnimatePresence>
        </div>
      </header>
    </>
  );
}

/* ---------- Hero + search ---------- */
const rise = d => ({ initial: { opacity: 0, y: 22, filter: 'blur(6px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' }, transition: { duration: 0.8, delay: d, ease: [0.22, 1, 0.36, 1] } });
/* Headline: each word rises out of a mask (like titles in a film), then a brush stroke is drawn under the second line. */
function HeroWords({ text, start = 0, accent = false }) {
  const reduce = useReducedMotion();
  return text.split(' ').map((w, i) => (
    <span key={i} className="inline-block overflow-hidden pb-[.12em] align-bottom [margin-bottom:-.12em]">
      <motion.span
        className={cn('inline-block', accent && 'animate-shine bg-[linear-gradient(90deg,#c9f36a,#f4ffd0,#9ed544,#c9f36a)] bg-[length:250%_100%] bg-clip-text text-transparent')}
        initial={reduce ? false : { y: '115%', rotate: 3, opacity: 0, filter: 'blur(10px)' }}
        animate={{ y: 0, rotate: 0, opacity: 1, filter: 'blur(0px)' }}
        transition={{ duration: 0.85, delay: start + i * 0.11, ease: [0.22, 1, 0.36, 1] }}
      >{w}</motion.span>{i < text.split(' ').length - 1 ? '\u00a0' : ''}
    </span>
  ));
}
function HeroStroke({ delay }) {
  // Camera viewfinder: corner brackets snap in around the line, then focus; a REC light blinks on the bottom edge.
  const reduce = useReducedMotion();
  const corner = 'absolute size-[.34em] border-lime';
  const frame = { initial: reduce ? false : { opacity: 0, scale: 1.18 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] } };
  return (
    <motion.span aria-hidden {...frame} className="pointer-events-none absolute -inset-x-[.16em] -inset-y-[.06em] origin-center">
      <span className={corner + ' left-0 top-0 rounded-tl-[3px] border-l-[3px] border-t-[3px]'} />
      <span className={corner + ' right-0 top-0 rounded-tr-[3px] border-r-[3px] border-t-[3px]'} />
      <span className={corner + ' bottom-0 left-0 rounded-bl-[3px] border-b-[3px] border-l-[3px]'} />
      <span className={corner + ' bottom-0 right-0 rounded-br-[3px] border-b-[3px] border-r-[3px]'} />
      <motion.span className="absolute inset-0 rounded-[4px] border border-lime/0" animate={reduce ? undefined : { borderColor: ['#c9f36a00', '#c9f36a66', '#c9f36a00'] }} transition={{ delay: delay + 0.5, duration: 0.9 }} />
      <span className="absolute -bottom-[.62em] right-[.3em] flex items-center gap-1 rounded-full bg-[#172337] px-1.5 py-0.5 font-display text-[9px] font-extrabold uppercase leading-none tracking-[.14em] text-white sm:text-[10px]">
        <span className={'size-1.5 rounded-full bg-[#ff4d4d] shadow-[0_0_8px_#ff4d4d] ' + (reduce ? '' : 'animate-pulse')} />REC
      </span>
    </motion.span>
  );
}
const TICKER_ROLES = ['Cinematographer', 'Gaffer', 'Sound mixer', 'Colourist', 'Editor', 'Director', 'Makeup artist', 'Drone pilot', 'Production designer', 'Stylist'];
function RoleTicker() {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0); const [n, setN] = useState(0); const [del, setDel] = useState(false);
  useEffect(() => {
    if (reduce) { const t = setInterval(() => setI(v => (v + 1) % TICKER_ROLES.length), 2400); return () => clearInterval(t); }
    const word = TICKER_ROLES[i];
    const t = setTimeout(() => {
      if (!del && n < word.length) setN(n + 1);
      else if (!del) setDel(true);
      else if (n > 0) setN(n - 1);
      else { setDel(false); setI((i + 1) % TICKER_ROLES.length); }
    }, !del && n === word.length ? 1500 : del ? 28 : 65);
    return () => clearTimeout(t);
  }, [i, n, del, reduce]);
  const word = TICKER_ROLES[i];
  return (
    <motion.p initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2, duration: 0.6 }} aria-live="off" className="mb-3 flex min-h-[1.6em] items-center gap-2 font-display text-sm font-bold tracking-[-.01em] text-[#c5d0db] sm:text-base">
      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.14em] text-lime">Now booking</span>
      <span className="text-white">{reduce ? word : word.slice(0, n)}<span aria-hidden className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-lime" /></span>
    </motion.p>
  );
}

export function Hero({ filters, setFilters, onJoin }) {
  const set = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));
  return (
    <section className="mx-auto w-[min(1200px,calc(100%-28px))] pt-3.5 sm:pt-10 pb-1">
      <div className="hero-dots relative isolate grid gap-2 overflow-hidden rounded-[22px] p-[25px_21px_16px] text-white shadow-[0_30px_70px_#17233733] sm:rounded-[28px] sm:p-[35px] md:grid-cols-[1.1fr_.9fr] lg:p-[50px]">
        <div aria-hidden className="absolute -inset-[20%] -z-10 animate-aurora" style={{ background: 'radial-gradient(40% 40% at 78% 30%,#c9f36a38,transparent 70%),radial-gradient(35% 45% at 20% 85%,#5fa8d33d,transparent 70%)' }} />
        <div aria-hidden className="absolute -right-20 -top-36 -z-10 size-[500px] rounded-full border border-white/10 shadow-[0_0_0_45px_#ffffff07,0_0_0_90px_#ffffff05]" />
        <div>
          <motion.div {...rise(0.05)} className="inline-flex items-center gap-2 rounded-full border border-lime/25 bg-lime/10 px-3 py-1.5 font-display text-[10px] font-extrabold uppercase tracking-[.16em] text-lime">
            <span className="size-1.5 animate-pulse-ring rounded-full bg-lime shadow-[0_0_0_0_#c9f36a99]" />The crew marketplace for production
          </motion.div>
          <h1 aria-label="Find your people. Make good work." className="my-4 max-w-[660px] font-display text-[clamp(38px,10.4vw,48px)] font-extrabold leading-[1.03] tracking-[-.06em] sm:text-[clamp(38px,5vw,66px)]">
            <span aria-hidden className="block"><HeroWords text="Find your people." start={0.15} /></span>
            <span aria-hidden className="relative inline-block">
              <HeroWords text="Make good work." start={0.6} accent />
              <HeroStroke delay={1.35} />
            </span>
          </h1>
          <RoleTicker />
          <motion.p {...rise(0.24)} className="max-w-[540px] text-sm leading-relaxed text-[#c5d0db] sm:text-base">Discover production professionals for film, TV, commercials and digital content. Compare skills, request a booking and keep the details organised in one place.</motion.p>
          <motion.div {...rise(0.34)} className="mt-5 flex gap-2.5 max-sm:flex-col sm:mt-6">
            <a href="#discover" className="max-sm:block"><Button className="max-sm:w-full">Explore professionals <ArrowDownRight className="size-4" aria-hidden="true" /></Button></a>
            <Button variant="ghostLight" onClick={onJoin} className="max-sm:w-full">Join the crew network <ArrowUpRight className="size-4" aria-hidden="true" /></Button>
          </motion.div>
        </div>
        <motion.div {...rise(0.2)} role="img" aria-label="Illustration of a film camera and production tools" className="flex min-h-[205px] items-center justify-center sm:min-h-[300px]">
          <CameraArt className="h-auto w-[min(85%,300px)] overflow-visible drop-shadow-[0_25px_35px_#0002] sm:w-[min(100%,370px)]" />
        </motion.div>
      </div>
      <form onSubmit={e => { e.preventDefault(); document.getElementById('discover')?.scrollIntoView({ behavior: 'smooth' }); }}
        className="relative z-[2] mx-0 mt-3 grid grid-cols-2 items-end gap-2.5 rounded-[17px] border border-line bg-white p-3 shadow-[0_22px_60px_#17233717] sm:mx-[clamp(10px,3vw,34px)] sm:-mt-6 sm:rounded-[20px] sm:p-4 md:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
        <Field label="Role or skill" htmlFor="q" className="col-span-2 md:col-span-1"><input id="q" className={inputCls} placeholder="e.g. cinematographer" value={filters.q} onChange={set('q')} /></Field>
        <Field label="Production category" htmlFor="category"><select id="category" className={inputCls} value={filters.category} onChange={set('category')}><option value="">All categories</option>{[...CATEGORIES, 'Makeup'].map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Location" htmlFor="location"><select id="location" className={inputCls} value={filters.location} onChange={set('location')}><option value="">Any location</option>{['Lagos', 'Abuja', 'Port Harcourt', 'Remote'].map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Sort by" htmlFor="sort" className="col-span-2 md:col-span-1"><select id="sort" className={inputCls} value={filters.sort} onChange={set('sort')}><option value="recommended">Recommended</option><option value="price-low">Price: low to high</option></select></Field>
        <Button variant="dark" type="submit" className="col-span-2 h-[46px] md:col-span-1">Search <ArrowUpRight className="size-4" aria-hidden="true" /></Button>
      </form>
      <Reveal className="mt-8 sm:mt-9"><Marquee items={[...CATEGORIES, 'Makeup'].map((c, i) => [i < 6 ? SYMBOLS[i] : <Brush key="m" {...S} />, c])} /></Reveal>
    </section>
  );
}

/* ---------- Discover ---------- */
export function SectionHead({ tag, title, children }) {
  return (
    <Reveal className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end sm:gap-5">
      <div><Tagline>{tag}</Tagline><h2 className="mt-2 font-display text-[29px] font-extrabold leading-[1.1] tracking-[-.055em] sm:text-[clamp(27px,3vw,40px)]">{title}</h2></div>
      <p className="max-w-[420px] text-[13px] leading-relaxed text-muted">{children}</p>
    </Reveal>
  );
}
function ProCard({ p, i, saved, onSave, onBook, inGroup, onGroup }) {
  return (
    <motion.div layout initial={{ opacity: 0, y: 26, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.18 } }} transition={{ duration: 0.5, delay: Math.min(i, 8) * 0.06, ease: [0.22, 1, 0.36, 1] }} className="flex">
      <SpotlightCard className="flex w-full flex-col rounded-[19px] border border-line bg-white shadow-[0_1px_2px_#1723370a] transition-shadow duration-300 hover:border-[#d3dfb8] hover:shadow-lift">
        <div className="relative z-[1] flex h-[145px] items-center justify-center overflow-hidden text-[44px] text-white/70 sm:h-[150px]" style={{ background: p.cover }}>
          <span aria-hidden className="absolute -right-5 -top-[60px] size-[170px] rounded-full border border-white/15 shadow-[0_0_0_25px_#ffffff09]" />
          <span aria-hidden className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-1000 ease-out group-hover/spot:translate-x-full" />
          {p.photo ? <img src={p.photo} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" /> : <motion.span className="relative" whileHover={{ scale: 1.25, rotate: -6 }}>{p.symbol}</motion.span>}
          <motion.button aria-label={(saved ? 'Remove ' : 'Save ') + p.name} aria-pressed={saved} whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.8 }} onClick={() => onSave(p.id)}
            className="absolute right-3 top-3 grid size-[31px] place-items-center rounded-full bg-white/90 text-[17px] text-ink">
            <motion.span key={String(saved)} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 12 }} className={saved ? 'text-[#e5484d]' : ''}><Heart className="size-[17px]" strokeWidth={2} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /></motion.span>
          </motion.button>
        </div>
        <div className="relative z-[1] flex flex-1 flex-col p-[15px] sm:p-[17px]">
          <h3 className="font-display text-[17px] font-extrabold tracking-[-.03em]">{p.name}</h3>
          <div className="my-1.5 mb-3 text-xs text-muted">{p.role} · {p.location}</div>
          <p className="mb-3.5 min-h-[38px] text-[13px] leading-relaxed text-[#566274] sm:text-xs">{p.desc}</p>
          <div className="mb-3 flex flex-wrap gap-1.5">{p.skills.map(s => <span key={s} className="rounded-md bg-[#f0f3f4] px-2 py-1 text-[10px] text-[#566274] transition-colors group-hover/spot:bg-[#edf5da] group-hover/spot:text-[#3e5a14]">{s}</span>)}</div>
          {p.showreel && <a href={p.showreel} target="_blank" rel="noopener noreferrer" className="mb-3 inline-flex w-fit items-center gap-1.5 text-xs font-extrabold text-[#5f7f22] underline underline-offset-4">View portfolio <ArrowUpRight className="size-3.5" aria-hidden="true" /></a>}
          <div className="mt-auto flex items-center justify-between gap-2.5 border-t border-[#edf0f1] pt-3.5">
            <div><strong className="font-display text-lg tracking-[-.04em] sm:text-[19px]">{naira(p.rate)}</strong><small className="block text-[10px] text-muted">{p.rate_unit === 'hour' ? 'per hour' : p.rate_unit === 'project' ? 'per project' : 'per day'} · {p.credits}{p.reviewCount > 0 && p.rating != null ? ' · ★ ' + p.rating.toFixed(1) + ' (' + p.reviewCount + ')' : ''}</small></div>
            <div className="flex items-center gap-1.5">
              {(!p.rate_unit || p.rate_unit === 'day') && <button type="button" aria-pressed={inGroup} onClick={() => onGroup(p.id)} className={cn('rounded-full border px-3 py-2 text-xs font-extrabold transition-colors', inGroup ? 'border-lime-deep bg-lime-soft text-ink' : 'border-line bg-white text-[#536072] hover:border-ink/30')}>{inGroup ? '✓ In group' : '+ Group'}</button>}
              <Button size="sm" variant="dark" onClick={() => onBook(p)}>Request booking</Button>
            </div>
          </div>
        </div>
      </SpotlightCard>
    </motion.div>
  );
}
export function Discover({ pros, loading, filters, setFilters, saved, onSave, onBook, group, onGroup, onGroupOpen, onGroupClear }) {
  const q = filters.q.toLowerCase().trim();
  let list = pros.filter(p => (!q || (p.name + ' ' + p.role + ' ' + p.category + ' ' + p.skills.join(' ')).toLowerCase().includes(q)) && (!filters.category || p.category === filters.category) && (!filters.location || p.location === filters.location));
  if (filters.sort === 'price-low') list = [...list].sort((a, b) => a.rate - b.rate);
  const chips = [['', 'All professionals'], ...CATEGORIES.map(c => [c, c])];
  return (
    <section id="discover" className="mx-auto w-[min(1200px,calc(100%-28px))] py-10 sm:py-14">
      <SectionHead tag="Discover talent" title="Book professionals for your next production.">Browse available crew, compare rates and send a booking request in a few taps. Need several people? Tap “+ Group” on each card to book a whole crew in one go. Keep all payments and chats in the app.</SectionHead>
      <div className="no-scrollbar -mx-0.5 mb-4 flex gap-2 overflow-x-auto px-0.5 pb-2 sm:flex-wrap">
        {chips.map(([v, l]) => (
          <motion.button key={v} whileTap={{ scale: 0.94 }} whileHover={{ y: -2 }} onClick={() => setFilters(f => ({ ...f, category: v }))} aria-pressed={filters.category === v}
            className={cn('relative whitespace-nowrap rounded-full border px-3.5 py-2 text-xs font-extrabold transition-colors', filters.category === v ? 'border-ink text-white' : 'border-line bg-white text-[#536072] hover:border-ink/30')}>
            {filters.category === v && <motion.span layoutId="chip" transition={{ type: 'spring', stiffness: 420, damping: 32 }} className="absolute inset-0 rounded-full bg-ink shadow-[0_8px_18px_#17233730]" />}
            <span className="relative">{l}</span>
          </motion.button>
        ))}
      </div>
      <div className="mb-4 flex items-center justify-between text-xs text-muted"><span>{loading ? 'Loading professionals…' : `${list.length} professional${list.length === 1 ? '' : 's'}`}</span></div>
      {loading ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-[18px]">{Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)}</div>
      ) : (
        <motion.div layout className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-[18px]">
          <AnimatePresence mode="popLayout">{list.map((p, i) => <ProCard key={p.id} p={p} i={i} saved={saved.has(p.id)} onSave={onSave} onBook={onBook} inGroup={group.has(p.id)} onGroup={onGroup} />)}</AnimatePresence>
        </motion.div>
      )}
      {group.size > 0 && (
        <div className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-[560px] items-center justify-between gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-lift">
          <span className="text-sm font-extrabold">{group.size} selected{group.size < 2 ? ' · add at least 2' : ''}</span>
          <span className="flex items-center gap-2"><button type="button" onClick={onGroupClear} className="text-xs text-[#c3ced9] underline">Clear</button><Button size="sm" disabled={group.size < 2} onClick={onGroupOpen}>Request group booking</Button></span>
        </div>
      )}
      {!loading && !list.length && <div className="rounded-2xl border border-dashed border-[#cbd3d7] bg-white p-8 text-center text-muted">No professionals match those filters. Try a different role or category.</div>}
    </section>
  );
}

/* ---------- How it works / Trust / Banner ---------- */
const STEPS = [['01', 'Find a professional', 'Filter by role, location and rate, then check skills, showreel and availability.'], ['02', 'Send a booking request', 'Tell them the dates, location and what you need. Agree any changes in the chat.'], ['03', 'Confirm & pay', 'Once the offer is accepted, pay through secure checkout. Never pay outside the app.'], ['04', 'Complete & review', 'Confirm the job is done, leave a review, or report a problem on the same booking.']];
export function How() {
  return (
    <section id="how" className="bg-white py-10 sm:py-14"><div className="mx-auto w-[min(1200px,calc(100%-28px))]">
      <SectionHead tag="Simple booking flow" title="From discovery to confirmed booking.">Your brief, agreed price, service fee and booking status live in one place.</SectionHead>
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([n, t, d], i) => (
          <Reveal key={n} delay={i * 0.08}>
            <motion.div whileHover={{ y: -5 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }} className="group relative h-full overflow-hidden rounded-[17px] border border-line bg-white p-[22px] transition-[box-shadow,border-color] hover:border-[#d3dfb8] hover:shadow-[0_20px_44px_#17233714]">
              <div className="grid size-8 place-items-center rounded-[10px] bg-lime-soft font-display text-xs font-extrabold transition-all duration-300 group-hover:rotate-[-8deg] group-hover:scale-110 group-hover:bg-lime">{n}</div>
              <h3 className="mb-2 mt-4 font-display text-base font-bold">{t}</h3><p className="text-xs leading-relaxed text-muted">{d}</p>
              <span className="absolute inset-x-[22px] bottom-0 h-[3px] origin-left scale-x-0 rounded-t bg-gradient-to-r from-lime-deep to-lime transition-transform duration-500 group-hover:scale-x-100" />
            </motion.div>
          </Reveal>
        ))}
      </div>
    </div></section>
  );
}
export function Trust() {
  const card = (dark, icon, title, text, i) => (
    <Reveal delay={i * 0.1}>
      <motion.div whileHover={{ y: -4 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }} className={cn('group relative h-full overflow-hidden rounded-[21px] p-7 transition-shadow hover:shadow-lift', dark ? 'bg-ink text-white' : 'bg-[#eaf2dd]')}>
        <span aria-hidden className={cn('absolute -right-[70px] -top-[90px] size-[220px] rounded-full transition-transform duration-700 group-hover:scale-150', dark ? 'bg-[radial-gradient(circle,#c9f36a2b,transparent_70%)]' : 'bg-[radial-gradient(circle,#ffffff80,transparent_70%)]')} />
        <div className={cn('relative grid size-[46px] place-items-center rounded-[14px] text-2xl', dark ? 'bg-white/10' : 'bg-white/70 shadow-[0_6px_16px_#17233712]')}>{icon}</div>
        <h3 className="relative mb-2 mt-3.5 font-display text-[23px] font-extrabold leading-tight tracking-[-.04em]">{title}</h3>
        <p className={cn('relative text-[13px] leading-relaxed', dark ? 'text-[#c3ced9]' : 'text-[#536044]')}>{text}</p>
      </motion.div>
    </Reveal>
  );
  return (
    <section id="trust" className="mx-auto w-[min(1200px,calc(100%-28px))] py-10 sm:py-14">
      <SectionHead tag="Book with confidence" title="Pay and talk inside the app.">Every booking, message and payment stays on one record, so both sides are covered if something goes wrong.</SectionHead>
      <div className="grid gap-4 md:grid-cols-2">
        {card(false, <ShieldCheck className="size-6" strokeWidth={1.75} aria-hidden="true" />, 'Verified crew and private contact details', 'Crew profiles are reviewed before they are listed. Phone numbers and emails stay hidden until a booking is confirmed, and you can report any suspicious account to our team.', 0)}
        {card(true, <ArrowLeftRight className="size-6" strokeWidth={1.75} aria-hidden="true" />, 'Clear terms, payments and records', 'Agree the dates and price in the chat, pay through secure checkout, and confirm when the job is done. Fees, cancellation rules and the dispute process are spelled out before you pay.', 1)}
      </div>
          <div role="note" className="mt-4 flex items-start gap-3 rounded-2xl border border-[#f1d28a] bg-[#fff8e6] p-4 text-[13px] leading-relaxed text-[#6b4e07]">
        <span aria-hidden className="text-xl">⚠️</span>
        <p><strong className="font-extrabold">Beware of scams.</strong> Never pay, send a deposit or agree a booking outside the app, even if someone offers a discount or says they are in a hurry. Payments made off the platform are not protected and cannot be refunded or disputed. Never share your password or verification codes, and report anyone who asks you to move the conversation to WhatsApp, email or a bank transfer.</p>
      </div>
    </section>
  );
}
export function Banner({ onJoin }) {
  return (
    <section id="join" className="mx-auto w-[min(1200px,calc(100%-28px))] pb-14">
      <Reveal className="relative flex flex-col items-start justify-between gap-5 overflow-hidden rounded-[19px] bg-gradient-to-br from-lime via-[#b6e456] to-[#d6f78e] p-6 sm:flex-row sm:items-center sm:rounded-[22px] sm:p-[35px]">
        <div aria-hidden className="absolute inset-0 animate-aurora" style={{ background: 'radial-gradient(circle at 90% 10%,#fff6,transparent 45%)' }} />
        <div className="relative"><h2 className="max-w-[650px] font-display text-[29px] font-extrabold leading-[1.05] tracking-[-.05em] sm:text-[clamp(27px,3vw,39px)]">Are you a production professional?</h2><p className="mt-2 text-[13px] text-[#536044]">Create a free profile, set your day rate and get booking requests straight to your inbox.</p></div>
        <Button variant="dark" onClick={onJoin} className="relative">Apply to join the network <ArrowUpRight className="size-4" aria-hidden="true" /></Button>
      </Reveal>
    </section>
  );
}

/* ---------- Dashboard ---------- */
/* ---------- Live booking chat ---------- */
function Chat({ bookingId, title, mine: mineType, onClose }) {
  const [msgs, setMsgs] = useState([]); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [live, setLive] = useState(false);
  const end = useRef(null);
  const add = m => setMsgs(a => (a.some(x => x.id === m.id) ? a : [...a, m]));
  useEffect(() => {
    let es;
    http(`/api/bookings/${bookingId}/messages`).then(r => { if (r.ok) setMsgs(r.data); else setErr(r.data.error || 'Could not load messages.'); });
    es = new EventSource(`/api/bookings/${bookingId}/messages/stream`);
    es.onopen = () => setLive(true); es.onerror = () => setLive(false);
    es.onmessage = e => add(JSON.parse(e.data));
    return () => es.close();
  }, [bookingId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);
  async function send(e) {
    e.preventDefault(); const content = text.trim(); if (!content) return;
    setText('');
    const r = await postJSON(`/api/bookings/${bookingId}/messages`, { content }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { setErr(r.data.error || 'Could not send.'); setText(content); return; }
    setErr(''); add(r.data);
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={onClose}>
      <div className="flex h-[min(560px,90vh)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><div><strong className="block text-sm">{title}</strong><span className="text-[11px] text-muted">{live ? 'Live' : 'Reconnecting…'}</span></div><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
        <div className="flex-1 space-y-2 overflow-y-auto bg-[#f7f9f6] p-3">
          {!msgs.length && <p className="p-4 text-center text-xs text-muted">No messages yet. Phone numbers and emails are masked.</p>}
          {msgs.map(m => { const mine = m.sender_type === mineType; return (
            <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <span className="mb-0.5 text-[10px] text-muted">{mine ? 'You' : m.sender_name}</span>
              <div className={cn('max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px]', mine ? 'bg-ink text-white' : 'border border-line bg-white')}>{m.masked_content}</div>
            </div>); })}
          <div ref={end} />
        </div>
        {err && <div className="px-4 pt-2 text-[11px] text-red-600">{err}</div>}
        <p className="border-t border-line bg-[#fff8e6] px-3 py-1.5 text-[11px] text-[#6b4e07]">Never pay or share bank details outside the app.</p>
        <form onSubmit={send} className="flex gap-2 p-3"><input className={cn(inputCls, 'flex-1')} value={text} onChange={e => setText(e.target.value)} maxLength={2000} placeholder="Type a message" aria-label="Message" /><Button type="submit">Send</Button></form>
      </div>
    </div>
  );
}

/* ---------- Client workspace ---------- */
export function Dashboard({ onBack, onJoin, openAuth, toast, user, onMessages }) {
  const [chat, setChat] = useState(null);
  const [rows, setRows] = useState(null); const [error, setError] = useState('');
  async function load() {
    setRows(null); setError('');
    const { ok, data } = await http('/api/my/bookings').catch(() => ({ ok: false, data: { error: 'Could not connect to backend.' } }));
    if (!ok) { setError(data.error || 'Could not load bookings.'); return; }
    setRows((data.bookings || []).map(b => ({ id: b.reference, dbId: b.id, counter: b.counter_details, pro: b.professional_name, role: b.professional_role, type: b.project_type, clientTotal: Number(b.client_total), crewNet: Number(b.crew_net), unit: b.booking_unit, date: String(b.start_date).slice(0, 10), end: String(b.end_date).slice(0, 10), location: b.project_location, status: String(b.status).replaceAll('_', ' ') })));
  }
  useEffect(() => { load(); }, []);
  const pending = (rows || []).filter(b => ['awaiting review', 'awaiting terms', 'confirmed'].includes(b.status)).length;
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto w-[min(1200px,calc(100%-28px))] pb-16 pt-6">
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div><Tagline>Client workspace</Tagline><h2 className="mt-2 font-display text-[28px] font-extrabold tracking-[-.05em] sm:text-[32px]">My bookings</h2></div>
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" />Browse crew</Button><Button onClick={onJoin}>Register as crew</Button></div>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        {[['Total booking requests', <AnimatedNumber value={rows?.length || 0} />], ['Awaiting confirmation', <AnimatedNumber value={pending} />], ['Payment status', 'Not connected']].map(([l, v], i) => (
          <motion.div key={l} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }} whileHover={{ y: -3 }} className={cn('rounded-2xl border border-line bg-white p-3.5 sm:p-5', i === 2 && 'col-span-2 sm:col-span-1')}>
            <small className="text-[11px] text-muted">{l}</small><strong className="mt-2 block font-display text-[23px] font-extrabold tracking-[-.05em] sm:text-[27px]">{v}</strong>
          </motion.div>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        <div className="border-b border-line px-5 py-[18px] font-extrabold">Your booking requests</div>
        {error ? <div className="p-7 text-[13px] text-muted">{error} <Button size="sm" variant="ghost" onClick={load}>Try again</Button></div>
          : rows === null ? <div className="p-7 text-[13px] text-muted">Loading your booking requests…</div>
          : !rows.length ? <div className="p-7 text-[13px] text-muted">No booking requests yet. Browse professionals and send your first request.</div>
          : rows.map((b, i) => (
            <motion.div key={b.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="grid gap-2 border-b border-[#edf0f1] p-[15px] text-xs transition-colors last:border-0 hover:bg-[#fafcf5] sm:grid-cols-[1.2fr_1fr_.8fr_.7fr] sm:items-center sm:gap-3 sm:px-5 sm:py-4">
              <div><strong>{b.pro}</strong><br /><span className="text-muted">{b.role}</span></div>
              <div>{b.date}{b.end && b.end !== b.date ? ' to ' + b.end : ''}<br /><span className="text-muted">{b.unit === 'half' ? 'Half day' : 'Full day(s)'}</span></div>
              <div><span className="inline-flex items-center gap-1.5 rounded-full bg-[#fff1d7] px-2.5 py-1 text-[10px] font-extrabold capitalize text-[#8b5c09]"><span className="size-[5px] rounded-full bg-current" />{b.status}</span><br /><span className="text-muted">Ref: {b.id}</span></div>
              <div><strong>{naira(b.clientTotal)}</strong><br /><span className="text-muted">you pay</span><div className="mt-2"><Button size="sm" variant="ghost" onClick={() => onMessages?.(b.dbId)}>Open chat</Button></div></div>
            </motion.div>
          ))}
      </div>
      {chat && <Chat bookingId={chat.id} title={chat.title} mine="client" onClose={() => setChat(null)} />}
      <p className="my-2.5 text-[11px] text-muted">Your booking requests are loaded from your account on the server.</p>
    </motion.section>
  );
}

/* ---------- Crew listings (booking requests live in Messages) ---------- */
export function CrewDashboard({ onBack, toast }) {
  return (
    <section className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div><Tagline>Crew workspace</Tagline><h2 className="mt-2 font-display text-[28px] font-extrabold tracking-[-.05em] sm:text-[32px]">My listings</h2><p className="mt-1 text-xs text-muted">Booking requests arrive in your Messages.</p></div>
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" />Back to marketplace</Button>
      </div>
      <CrewListing toast={toast} />
    </section>
  );
}

/* ---------- Footer ---------- */
export function Footer({ openLegal, onTools, onJobs }) {
  const lk = 'transition-colors hover:text-lime';
  return (
    <footer className="bg-ink py-9 text-white" style={{ background: 'radial-gradient(600px 240px at 80% 0,#c9f36a14,transparent 70%),#172337' }}>
      <div className="mx-auto w-[min(1200px,calc(100%-28px))]">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <a href="#" className="flex items-center gap-2.5 whitespace-nowrap font-display text-sm font-extrabold tracking-[-.03em]"><span className="grid size-9 place-items-center rounded-xl bg-lime text-lg text-ink">C</span><span>CREW MANAGEMENT<small className="block text-[9px] tracking-[.16em] text-[#aebbc8]">AGENCY · NIGERIA</small></span></a>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#d2dbe3]">
            {[['#discover', 'Find crew'], ['#how', 'How it works'], ['#trust', 'Safe bookings'], ['#join', 'Join as crew']].map(([h, l]) => <a key={h} href={h} className={lk}>{l}</a>)}
            <button type="button" onClick={onJobs} className={lk}>Job board</button>
            <button type="button" onClick={onTools} className={lk}>Free call sheet</button>
            {[['terms', 'Terms'], ['privacy', 'Privacy'], ['cancellation', 'Cancellation & refunds'], ['crew', 'Crew & payouts']].map(([k, l]) => <button key={k} type="button" onClick={() => openLegal(k)} className={lk}>{l}</button>)}
          </div>
        </div>
        <p className="mt-4 text-[11px] text-[#aebbc8]">Pay and communicate only inside the app. Never send money or deal outside the platform.</p>
        <div className="mt-6 flex flex-col justify-between gap-2 border-t border-white/15 pt-4 text-[10px] text-[#aab6c2] sm:flex-row"><span>© {new Date().getFullYear()} Crew Management Agency</span><span>Built for production professionals · Nigeria</span></div>
      </div>
    </footer>
  );
}
