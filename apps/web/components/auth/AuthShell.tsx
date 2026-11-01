"use client";

import { Moon, Sun } from "@phosphor-icons/react";
import { useTheme } from "@/components/providers/ThemeProvider";
import { IconButton } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";

/** Centered card layout for the public auth pages (login, forgot / reset password). */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg px-4">
      <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} className="absolute right-4 top-4">
        {theme === "dark" ? <Sun size={22} /> : <Moon size={22} />}
      </IconButton>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={56} />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
            {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        <div className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">{children}</div>
      </div>
    </main>
  );
}
