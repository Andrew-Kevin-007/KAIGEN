"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

export default function VideoModal({ open, onClose, src, poster }: { open: boolean; onClose: () => void; src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.19, 1, 0.22, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(1100px, 100%)", aspectRatio: "16 / 9", borderRadius: 24, overflow: "hidden", background: "#000" }}
          >
            <video ref={ref} src={src} poster={poster} controls autoPlay playsInline style={{ width: "100%", height: "100%" }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
