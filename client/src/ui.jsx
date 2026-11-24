import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useInView, useMotionValue, useScroll, useSpring, useTransform } from 'motion/react';
import { cn } from './lib.js';

/* ---------- Button (spring press + light sweep) ---------- */
const variants = {
  lime: 'bg-lime text-ink hover:shadow-[0_8px_22px_#17233726]',
  dark: 'bg-ink text-white hover:shadow-[0_8px_22px_#17233740]',
  ghost: 'bg-transparent border border-line text-ink hover:bg-white hover:border-[#cfd7df]',
  ghostLight: 'bg-transparent border border-white/30 text-white hover:bg-white/10'
};
export function Button({ variant = 'lime', size = 'md', className, children, ...p }) {
  return (
    <motion.button
      whileHover={p.disabled ? undefined : { y: -2 }} whileTap={p.disabled ? undefined : { scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      className={cn('group relative inline-flex items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-full font-display font-bold disabled:opacity-60 disabled:cursor-wait', size === 'sm' ? 'px-3.5 py-2.5 text-xs' : 'px-5 py-3 text-sm', variants[variant], className)}
      {...p}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[120%]" />
      <span className="relative inline-flex items-center gap-2">{children}</span>
    </motion.button>
  );
}

/* ---------- Form bits ---------- */
export const inputCls = 'w-full rounded-xl border border-[#e2e7e9] bg-white px-3.5 py-3 text-base sm:text-sm text-ink outline-none transition hover:border-[#c9d2da] focus:border-[#8cab48] focus:shadow-[0_0_0_3px_#c9f36a50] read-only:bg-[#f5f7f3] disabled:bg-[#f5f7f3] disabled:text-muted';
export function Field({ label, htmlFor, full, className, children }) {
  return (
    <div className={cn('flex flex-col gap-1.5', full && 'sm:col-span-2', className)}>
      <label htmlFor={htmlFor} className="text-[11px] font-extrabold uppercase tracking-[.08em] text-[#566274]">{label}</label>
      {children}
    </div>
  );
}
export const Tagline = ({ children }) => (
  <div className="inline-flex items-center gap-2 font-display text-[10px] font-extrabold uppercase tracking-[.15em] text-[#688a2b]">
    <span className="h-0.5 w-[18px] rounded bg-lime-deep" />{children}
  </div>
);

/* ---------- Scroll reveal ---------- */
export function Reveal({ children, delay = 0, className, as = 'div', ...p }) {
  const M = motion[as];
  return (
    <M initial={{ opacity: 0, y: 28, filter: 'blur(4px)' }} whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '0px 0px -50px 0px' }} transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }} className={className} {...p}>
      {children}
    </M>
  );
}

/* ---------- Spotlight card ---------- */
export function SpotlightCard({ className, children, ...p }) {
  const ref = useRef(null);
  const move = e => {
    const r = ref.current.getBoundingClientRect();
    ref.current.style.setProperty('--mx', e.clientX - r.left + 'px');
    ref.current.style.setProperty('--my', e.clientY - r.top + 'px');
  };
  return (
    <motion.article ref={ref} onPointerMove={move} whileHover={{ y: -6 }} transition={{ type: 'spring', stiffness: 380, damping: 24 }}
      className={cn('group/spot relative overflow-hidden', className)} {...p}>
      <span aria-hidden className="pointer-events-none absolute inset-0 z-0 opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100"
        style={{ background: 'radial-gradient(260px circle at var(--mx,50%) var(--my,50%), #c9f36a40, transparent 65%)' }} />
      {children}
    </motion.article>
  );
}

/* ---------- Sliding tabs (shared-layout pill) ---------- */
export function SlidingTabs({ tabs, value, onChange, id, className }) {
  return (
    <div role="tablist" className={cn('relative flex gap-1 rounded-[13px] bg-[#f1f3f5] p-1', className)}>
      {tabs.map(t => (
        <button key={t.value} role="tab" aria-selected={value === t.value} type="button" onClick={() => onChange(t.value)}
          className={cn('relative z-10 flex-1 whitespace-nowrap rounded-[9px] px-3 py-2.5 text-[13px] font-extrabold transition-colors', value === t.value ? 'text-ink' : 'text-muted')}>
          {value === t.value && <motion.span layoutId={id} transition={{ type: 'spring', stiffness: 420, damping: 32 }} className="absolute inset-0 -z-10 rounded-[9px] bg-white shadow-[0_2px_8px_#17233718]" />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Animated number ---------- */
export function AnimatedNumber({ value, format = v => Math.round(v) }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, v => String(format(v)));
  useEffect(() => { const c = animate(mv, Number(value) || 0, { duration: 0.9, ease: [0.22, 1, 0.36, 1] }); return () => c.stop(); }, [value]);
  return <motion.span>{text}</motion.span>;
}

/* ---------- Scroll progress ---------- */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 28, mass: 0.2 });
  return <motion.div style={{ scaleX }} className="fixed left-0 top-0 z-[60] h-[3px] w-full origin-left bg-gradient-to-r from-lime-deep to-lime" />;
}

/* ---------- Marquee ---------- */
export function Marquee({ items }) {
  const row = items.map(([sym, label], i) => (
    <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-white px-4 py-2 text-[13px] font-bold text-[#445468] shadow-[0_2px_8px_#1723370a]">
      <i className="not-italic text-[#6c9a23]">{sym}</i>{label}
    </span>
  ));
  return (
    <div aria-hidden className="group overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
      <div className="flex w-max animate-marquee gap-3 group-hover:[animation-play-state:paused]">{row}{row}{row}{row}</div>
    </div>
  );
}

/* ---------- Skeleton ---------- */
const sk = 'block rounded-lg bg-[linear-gradient(90deg,#eef1f3_25%,#f8f9fa_50%,#eef1f3_75%)] bg-[length:200%_100%] animate-skeleton';
export const SkeletonCard = () => (
  <div className="overflow-hidden rounded-[19px] border border-line bg-white">
    <i className={cn(sk, 'h-[150px] rounded-none')} />
    <div className="grid gap-2.5 p-[17px]"><i className={cn(sk, 'h-4 w-[55%]')} /><i className={cn(sk, 'h-3 w-3/4')} /><i className={cn(sk, 'h-3 w-[90%]')} /><i className={cn(sk, 'mt-2 h-9 w-full')} /></div>
  </div>
);

/* ---------- Responsive helper ---------- */
export function useIsMobile(q = '(max-width: 640px)') {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => { const mq = matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return m;
}

/* ---------- Modal ---------- */
export function Modal({ open, onClose, labelledBy, className, children }) {
  const mobile = useIsMobile();
  useEffect(() => {
    if (!open) return;
    const k = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="bd" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onMouseDown={e => e.target === e.currentTarget && onClose()}
          className="fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto bg-[#0b142280] backdrop-blur-[6px] sm:items-center sm:p-[18px]">
          <motion.div
            initial={mobile ? { y: '100%' } : { opacity: 0, y: 24, scale: 0.94 }} animate={mobile ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }} exit={mobile ? { y: '100%' } : { opacity: 0, y: 16, scale: 0.97 }}
            transition={mobile ? { type: 'spring', stiffness: 380, damping: 36 } : { type: 'spring', stiffness: 380, damping: 26 }}
            className={cn('m-auto max-h-[92dvh] w-full overflow-auto rounded-t-[22px] bg-white p-[22px_18px_calc(20px+env(safe-area-inset-bottom))] shadow-[0_30px_90px_#0004] sm:max-w-[620px] sm:rounded-[22px] sm:p-[25px]', className)}>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
export function ModalHead({ tag, title, id, onClose }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div><Tagline>{tag}</Tagline><h2 id={id} className="mt-2 font-display text-2xl font-extrabold leading-tight tracking-[-.04em] sm:text-[27px]">{title}</h2></div>
      <motion.button whileHover={{ rotate: 90 }} whileTap={{ scale: 0.9 }} onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full bg-[#f0f2f3] text-xl hover:bg-[#e4e8eb]">×</motion.button>
    </div>
  );
}

/* ---------- Toast ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [t, setT] = useState(null); const timer = useRef();
  const show = useCallback(msg => { clearTimeout(timer.current); setT({ msg, id: Date.now() }); timer.current = setTimeout(() => setT(null), 3600); }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4" role="status" aria-live="polite">
        <AnimatePresence mode="wait">
          {t && (
            <motion.div key={t.id} initial={{ opacity: 0, y: 24, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.97 }} transition={{ type: 'spring', stiffness: 420, damping: 28 }}
              className="pointer-events-auto flex max-w-[480px] items-center gap-2.5 rounded-[14px] bg-[#172337ee] px-[18px] py-3.5 text-[13px] text-white shadow-soft backdrop-blur-md">
              <span className="size-2 shrink-0 rounded-full bg-lime shadow-[0_0_12px_#c9f36a]" />{t.msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
