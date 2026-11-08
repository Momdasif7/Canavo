"use client";

import { createContext, useCallback, useContext, useState } from "react";
import clsx from "clsx";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (message: string, tone: Tone = "info") => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3500);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4 print:hidden" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={clsx(
              "pointer-events-auto flex animate-pop-in items-start gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg",
              t.tone === "success" && "bg-secondary",
              t.tone === "error" && "bg-red-600",
              t.tone === "info" && "bg-gray-900 dark:bg-gray-700",
            )}
          >
            {t.tone === "success" ? <CheckCircle size={20} weight="fill" /> : t.tone === "error" ? <WarningCircle size={20} weight="fill" /> : <Info size={20} weight="fill" />}
            <span className="flex-1">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="opacity-80 hover:opacity-100">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
