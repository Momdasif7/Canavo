"use client";

import { useEffect, useRef } from "react";

type Handler = (e: KeyboardEvent) => void;

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Global keyboard shortcuts. Keys are KeyboardEvent.key values ("F2", "/", "Escape").
 * Printable keys are ignored while the user is typing in a field; function keys always fire.
 */
export function useHotkeys(map: Record<string, Handler>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const handler = ref.current[e.key];
      if (!handler) return;
      if (e.key.length === 1 && isTyping(e.target)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
