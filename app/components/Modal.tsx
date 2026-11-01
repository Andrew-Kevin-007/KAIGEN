"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusPlan } from "@/lib/focus";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SKIPPED = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);
// How long a closed dialog keeps looking for its opener to be enabled again (a wallet approval can take a while).
const WAIT_MS = 120_000;

/**
 * Keeps everything outside the dialog out of reach: not focusable, not clickable, hidden from screen readers.
 * The dialog is a direct child of <body> (a portal), so its siblings are the whole rest of the page. Returns the undo.
 */
function isolateFromPage(dialogRoot: HTMLElement): () => void {
  const undo: (() => void)[] = [];
  for (const el of Array.from(document.body.children)) {
    if (el === dialogRoot || SKIPPED.has(el.tagName) || !(el instanceof HTMLElement)) continue;
    const wasInert = el.inert;
    const wasHidden = el.getAttribute("aria-hidden");
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    undo.push(() => {
      el.inert = wasInert;
      if (wasHidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", wasHidden);
    });
  }
  return () => undo.forEach((u) => u());
}

/** The page behind the dialog does not scroll. The width of the scrollbar that goes away is added as padding, so nothing shifts. */
function lockScroll(): () => void {
  const body = document.body;
  const { overflow, paddingRight } = body.style;
  const bar = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = "hidden";
  if (bar > 0) body.style.paddingRight = `${bar}px`;
  return () => {
    body.style.overflow = overflow;
    body.style.paddingRight = paddingRight;
  };
}

/** Somewhere sensible for focus to sit when its control cannot take it: the page's main region, not the top of the document. */
function parkFocus(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return null;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  main.focus({ preventScroll: true });
  return main;
}

/**
 * Gives focus back to `opener` when the dialog closes. If the opener is disabled at that moment (confirming often
 * starts the work that disables it), focus() would silently do nothing and focus would fall to the top of the page,
 * so focus is parked on the main region and handed to the opener the moment it is enabled again, unless the person
 * has moved on by then.
 */
function restoreFocus(opener: HTMLElement | null): void {
  const plan = focusPlan(opener);
  if (plan === "focus") {
    opener?.focus();
    return;
  }
  const parked = parkFocus();
  if (plan !== "wait" || !opener) return;
  let timer = 0;
  const observer = new MutationObserver(() => {
    if (!opener.isConnected) return stop();
    if (focusPlan(opener) !== "focus") return;
    const active = document.activeElement;
    if (active === document.body || active === parked) opener.focus();
    stop();
  });
  const moved = (e: FocusEvent) => {
    if (e.target !== parked && e.target !== document.body) stop();
  };
  function stop() {
    observer.disconnect();
    document.removeEventListener("focusin", moved);
    window.clearTimeout(timer);
  }
  observer.observe(opener, { attributes: true, attributeFilter: ["disabled"] });
  document.addEventListener("focusin", moved);
  timer = window.setTimeout(stop, WAIT_MS);
}

/**
 * A modal dialog on a flat overlay: it is named by its heading, the page behind it is inert and does not scroll,
 * focus moves in, Tab stays inside, Escape closes, and focus returns to the control that opened it (waiting for that
 * control if it is disabled by then). The only motion is a 100 ms fade.
 */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const overlay = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, without making the effect below re-run (and steal focus) on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || !overlay.current) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const unisolate = isolateFromPage(overlay.current);
    const unlock = lockScroll();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // The page must be reachable again before focus can go back to it.
      unisolate();
      unlock();
      restoreFocus(opener);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={overlay}
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
