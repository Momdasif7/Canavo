"use client";

import clsx from "clsx";
import type { AttendanceRecord, AttendanceStatus, CalendarStatus } from "@/lib/types";

export const STATUS_ORDER: AttendanceStatus[] = ["PRESENT", "HALF_DAY", "ABSENT", "LEAVE"];

/** Labels and colours shared by the register, dialogs, records table and calendar. */
export const STATUS_META: Record<AttendanceStatus, { short: string; label: string; solid: string; tone: "success" | "warning" | "danger" | "info" }> = {
  PRESENT: { short: "P", label: "Present", solid: "bg-secondary text-white border-secondary", tone: "success" },
  HALF_DAY: { short: "HD", label: "Half day", solid: "bg-amber-400 text-black border-amber-400", tone: "warning" },
  ABSENT: { short: "A", label: "Absent", solid: "bg-red-500 text-white border-red-500", tone: "danger" },
  LEAVE: { short: "L", label: "Leave", solid: "bg-sky-500 text-white border-sky-500", tone: "info" },
};

export const CAL_STYLE: Record<CalendarStatus, { cls: string; label: string }> = {
  PRESENT: { cls: "bg-secondary text-white", label: "Present" },
  HALF_DAY: { cls: "bg-amber-400 text-black", label: "Half day" },
  LEAVE: { cls: "bg-sky-500 text-white", label: "Leave" },
  ABSENT: { cls: "bg-red-500 text-white", label: "Absent" },
  UPCOMING: { cls: "bg-surface-2 text-muted", label: "Upcoming" },
};

export const needsTimes = (s: AttendanceStatus | null | undefined) => s === "PRESENT" || s === "HALF_DAY";

/** Fallback when an employee has no shift assigned. */
export const DEFAULT_SHIFT = { startTime: "09:00", endTime: "18:00" };

/** ISO instant → "HH:MM" (24h) in the outlet's timezone, as the API expects. */
export function toHHMM(iso: string | null | undefined, timeZone = "Asia/Kolkata"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** "HH:MM" → "9:07 am" for display. */
export function hhmmLabel(hhmm: string): string {
  if (!hhmm) return "—";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** True for a record that carries real in/out times (absent / leave records are zero-length placeholders). */
export const hasTimes = (r: Pick<AttendanceRecord, "status">) => needsTimes(r.status);

/** Human text for where a record came from. */
export function sourceLabel(r: Pick<AttendanceRecord, "source" | "clockInDistance" | "editedAt">, markerName: string | null): { label: string; tone: "neutral" | "info" | "primary" } {
  if (r.source === "MANUAL") return { label: markerName ? `Manual · ${markerName}` : "Manual", tone: "primary" };
  if (r.editedAt) return { label: markerName ? `Edited by ${markerName}` : "Edited", tone: "info" };
  return { label: r.clockInDistance >= 0 ? "Self (GPS)" : "Self", tone: "neutral" };
}

/** P / HD / A / L segmented control. */
export function StatusPicker({
  value,
  onChange,
  disabled,
  size = "md",
  label = "Status",
}: {
  value: AttendanceStatus | null;
  onChange: (s: AttendanceStatus) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-line bg-surface-2 p-1">
      {STATUS_ORDER.map((s) => {
        const meta = STATUS_META[s];
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={meta.label}
            title={meta.label}
            disabled={disabled}
            onClick={() => onChange(s)}
            className={clsx(
              "rounded-lg border font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed",
              size === "sm" ? "min-h-[36px] min-w-[40px] px-2 text-sm" : "min-h-[42px] min-w-[48px] px-3 text-sm",
              active ? meta.solid : "border-transparent text-muted hover:bg-surface hover:text-fg",
              disabled && !active && "opacity-50",
            )}
          >
            {meta.short}
          </button>
        );
      })}
    </div>
  );
}

/** Compact native time input (24h value, HH:MM). */
export function TimeField({
  label,
  value,
  onChange,
  disabled,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <input
        type="time"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          "min-h-[42px] w-[136px] rounded-xl border bg-surface px-2.5 text-[15px] text-fg tabular focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50",
          invalid ? "border-red-500" : "border-line",
        )}
      />
    </label>
  );
}
