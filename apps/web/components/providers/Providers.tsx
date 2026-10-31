"use client";

import { useEffect } from "react";
import { ThemeProvider } from "./ThemeProvider";
import { ToastProvider } from "./ToastProvider";
import { SessionProvider } from "./SessionProvider";
import { ConnectivityProvider } from "./ConnectivityProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* PWA install is optional */
      });
    }
  }, []);

  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <ConnectivityProvider>{children}</ConnectivityProvider>
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
