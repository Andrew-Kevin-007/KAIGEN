"use client";

import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

// Behaviour ported from the original Send/Receive/Swap and Onboarding sections: one tile is active at a time while the
// section is on screen; the active tile scales up, its label slides down and its video plays, then hands over to the next.

const SPRING = { type: "spring", mass: 4, stiffness: 800, damping: 80, restDelta: 1e-4 } as const;

type Seq = { inView: boolean; current: number; next: () => void; mobile: boolean };
const SeqCtx = createContext<Seq>({ inView: false, current: 0, next: () => {}, mobile: false });
const TileCtx = createContext(0);

export function VideoSequence({ count, className, children }: { count: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [current, setCurrent] = useState(0);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return (
    <SeqCtx.Provider value={{ inView, current, next: () => setCurrent((c) => (c + 1) % count), mobile }}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </SeqCtx.Provider>
  );
}

function useActive() {
  const seq = useContext(SeqCtx);
  const index = useContext(TileCtx);
  // Reduced motion: no tile is ever "active", so nothing scales or slides and no video starts (a poster-less first frame stays).
  const reduce = useReducedMotion();
  return { seq, active: !reduce && seq.inView && (seq.mobile || index === seq.current) };
}

export function Tile({ index, style, children }: { index: number; style?: CSSProperties; children: ReactNode }) {
  return (
    <TileCtx.Provider value={index}>
      <div style={style}>{children}</div>
    </TileCtx.Provider>
  );
}

export function TilePanel({ className, style, children }: { className?: string; style?: CSSProperties; children: ReactNode }) {
  const { active } = useActive();
  return (
    <motion.div className={className} style={style} initial={{ originY: 0 }} animate={{ scale: active ? 1.1 : 1 }} transition={SPRING}>
      {children}
    </motion.div>
  );
}

export function TileLabel({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  const { active } = useActive();
  return (
    <motion.div style={style} animate={{ y: active ? 42 : 0 }} transition={SPRING}>
      {children}
    </motion.div>
  );
}

export function TileVideo({ src, style }: { src: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { seq, active } = useActive();
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active) {
      v.currentTime = 0;
      v.play().catch(() => {});
    } else {
      v.pause();
      v.currentTime = 0;
    }
  }, [active]);
  return <video ref={ref} src={src} preload="auto" muted playsInline style={style} onEnded={() => seq.next()} />;
}

// Looping clips (watch / collectibles / activity): play while on screen, pause when scrolled away.
export function LoopVideo({ src, style }: { src: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduce = useReducedMotion();
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (inView && !reduce) v.play().catch(() => {});
    else v.pause();
  }, [inView, reduce]);
  return <video ref={ref} src={src} preload="auto" loop muted playsInline style={style} />;
}
