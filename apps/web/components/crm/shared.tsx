import clsx from "clsx";
import type { LoyaltyTierName } from "@canavo/shared";

// ---------- Tiers ----------
export const TIER_LABELS: Record<LoyaltyTierName, string> = {
  BRONZE: "Bronze",
  SILVER: "Silver",
  GOLD: "Gold",
  PLATINUM: "Platinum",
};

const tierStyles: Record<LoyaltyTierName, string> = {
  BRONZE: "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-200 dark:border-orange-700/50",
  SILVER: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-500/20 dark:text-slate-200 dark:border-slate-400/40",
  GOLD: "bg-yellow-50 text-yellow-800 border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-200 dark:border-yellow-500/40",
  PLATINUM: "bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/40",
};

const tierDots: Record<LoyaltyTierName, string> = {
  BRONZE: "bg-orange-500",
  SILVER: "bg-slate-400",
  GOLD: "bg-yellow-500",
  PLATINUM: "bg-violet-500",
};

export function TierBadge({ tier, className }: { tier: LoyaltyTierName; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        tierStyles[tier],
        className,
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", tierDots[tier])} aria-hidden />
      {TIER_LABELS[tier]}
    </span>
  );
}

// ---------- Stat tile ----------
export function StatTile({
  label,
  value,
  note,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: "danger" | "success";
  className?: string;
}) {
  return (
    <div className={clsx("rounded-2xl border border-line bg-surface p-4 shadow-sm", className)}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p
        className={clsx(
          "tabular mt-1 text-xl font-extrabold",
          tone === "danger" && "text-red-600 dark:text-red-400",
          tone === "success" && "text-secondary dark:text-green-300",
        )}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

// ---------- Dates ----------
export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

export function relativeDays(iso: string | null | undefined): string {
  const d = daysSince(iso);
  if (d === null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "07-02" → "2 Jul" */
export function formatMMDD(mmdd: string | null | undefined): string {
  if (!mmdd) return "—";
  const [m, d] = mmdd.split("-").map(Number);
  return MONTHS[m - 1] ? `${d} ${MONTHS[m - 1]}` : mmdd;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → value for <input type="datetime-local"> in the browser's timezone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value → ISO, or null when blank/invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// ---------- Validation ----------
/** Zod issues → { "path.to.field": message } (first message per path). */
export function issuesToErrors(issues: readonly { path: (string | number)[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.join(".") || "_form";
    out[k] ??= i.message;
  }
  return out;
}

/** Keep only digits and one decimal point (₹ inputs). */
export const decimalOnly = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
export const digitsOnly = (v: string) => v.replace(/\D/g, "");
/** Allow a leading minus sign (signed integer inputs). */
export const signedDigits = (v: string) => v.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "");

/** Parse an optional positive integer input ("" → null). */
export function intOrNull(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
