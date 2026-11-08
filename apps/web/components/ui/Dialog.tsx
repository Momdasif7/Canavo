"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X } from "@phosphor-icons/react";
import { IconButton } from "./Button";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open overlays, top-most last, so Esc only closes the top one. */
const stack: symbol[] = [];

function useOverlay(open: boolean, onClose: () => void, panelRef: React.RefObject<HTMLElement>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = Symbol("overlay");
    stack.push(id);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const target =
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select, textarea, button:not([aria-label='Close'])");
      (target ?? panel).focus();
    }, 30);

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      // Keep Tab / Shift+Tab inside the top-most dialog (aria-modal promises it; QA ui-8).
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return void e.preventDefault();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = panel.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
      if (!stack.length) document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, panelRef]);
}

function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Prevent closing via backdrop click (e.g. while a payment is in flight) */
  dismissible?: boolean;
  /** Control shown before the title (e.g. a Back button); kept out of the heading so it isn't part of the dialog's name */
  leading?: React.ReactNode;
}

const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

export function Dialog({ open, onClose, title, description, children, footer, size = "md", dismissible = true, leading }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, () => dismissible && onClose(), panelRef);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
        <div className="absolute inset-0 animate-fade-in bg-black/50" onClick={() => dismissible && onClose()} aria-hidden />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={clsx(
            "relative flex max-h-[92vh] w-full animate-pop-in flex-col rounded-t-2xl border border-line bg-surface shadow-2xl outline-none sm:rounded-2xl",
            widths[size],
          )}
        >
          {(title || dismissible) && (
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3">
              <div className="flex min-w-0 items-start gap-2">
                {leading && <div className="pt-1.5">{leading}</div>}
                <div className="py-1.5">
                  {title && (
                    <h2 id={titleId} className="text-lg font-bold text-fg">
                      {title}
                    </h2>
                  )}
                  {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
                </div>
              </div>
              {dismissible && (
                <IconButton label="Close" onClick={onClose} className="-mr-2">
                  <X size={22} />
                </IconButton>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-xl",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, onClose, panelRef);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={onClose} aria-hidden />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={clsx("relative flex h-full w-full animate-slide-in-right flex-col border-l border-line bg-surface shadow-2xl outline-none", width)}
        >
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-2">
            <h2 id={titleId} className="text-lg font-bold text-fg">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X size={22} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
