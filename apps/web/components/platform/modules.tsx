"use client";

import clsx from "clsx";
import { Check, Info } from "@phosphor-icons/react";
import { MODULES, MODULE_INFO, type ModuleKey } from "@canavo/shared";
import { Badge } from "@/components/ui/Badge";
import type { BusinessStatus } from "@/lib/types";

/** Modules that (directly) require `m`. */
const dependentsOf = (m: ModuleKey) => MODULES.filter((x) => MODULE_INFO[x].requires.includes(m));

/**
 * Toggle a module keeping dependencies consistent: ticking adds what it requires
 * (Tables → Billing); unticking removes modules that need it. Returns the new
 * list (in canonical order) and a note explaining any automatic change.
 */
export function toggleModule(current: ModuleKey[], m: ModuleKey): { modules: ModuleKey[]; note: string | null } {
  const set = new Set(current);
  let note: string | null = null;
  if (set.has(m)) {
    set.delete(m);
    const removed = dependentsOf(m).filter((d) => set.has(d));
    removed.forEach((d) => set.delete(d));
    if (removed.length) note = `${removed.map((d) => MODULE_INFO[d].label).join(", ")} ${removed.length === 1 ? "was" : "were"} also switched off — ${removed.length === 1 ? "it needs" : "they need"} ${MODULE_INFO[m].label}.`;
  } else {
    set.add(m);
    const added = MODULE_INFO[m].requires.filter((r) => !current.includes(r));
    added.forEach((r) => set.add(r));
    if (added.length) note = `${added.map((r) => MODULE_INFO[r].label).join(", ")} ${added.length === 1 ? "was" : "were"} switched on too — ${MODULE_INFO[m].label} needs ${added.length === 1 ? "it" : "them"}.`;
  }
  return { modules: MODULES.filter((x) => set.has(x)), note };
}

/** Grid of module cards with descriptions and dependency hints. */
export function ModulePicker({
  value,
  onChange,
  note,
  disabled,
}: {
  value: ModuleKey[];
  onChange: (modules: ModuleKey[], note: string | null) => void;
  note?: string | null;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {note && (
        <p className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200" role="status">
          <Info size={18} weight="fill" className="mt-0.5 shrink-0" /> {note}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {MODULES.map((m) => {
          const info = MODULE_INFO[m];
          const on = value.includes(m);
          return (
            <button
              key={m}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              data-module={m}
              onClick={() => {
                const r = toggleModule(value, m);
                onChange(r.modules, r.note);
              }}
              className={clsx(
                "flex min-h-[64px] items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line hover:bg-surface-2",
              )}
            >
              <span
                className={clsx(
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                  on ? "border-primary bg-primary text-white" : "border-line bg-surface",
                )}
                aria-hidden
              >
                {on && <Check size={14} weight="bold" />}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{info.label}</span>
                <span className="block text-xs text-muted">{info.description}</span>
                {info.requires.length > 0 && (
                  <span className="mt-0.5 block text-[11px] font-semibold text-muted/80">Needs {info.requires.map((r) => MODULE_INFO[r].label).join(", ")}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">Staff, attendance logins, settings and the menu are always available.</p>
    </div>
  );
}

export function ModuleChips({ modules, max }: { modules: ModuleKey[]; max?: number }) {
  const shown = max ? modules.slice(0, max) : modules;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((m) => (
        <span key={m} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted">
          {MODULE_INFO[m]?.label ?? m}
        </span>
      ))}
      {max && modules.length > max && <span className="px-1 text-[11px] font-semibold text-muted">+{modules.length - max}</span>}
    </span>
  );
}

export function BusinessStatusBadge({ status }: { status: BusinessStatus }) {
  return status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>;
}
