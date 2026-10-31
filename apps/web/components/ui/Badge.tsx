import clsx from "clsx";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg border-line",
  primary: "bg-primary-50 text-primary-700 border-primary-200 dark:bg-primary/15 dark:text-primary-200 dark:border-primary/30",
  success: "bg-secondary-50 text-secondary-700 border-secondary-100 dark:bg-secondary/25 dark:text-green-200 dark:border-secondary/40",
  warning: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
  danger: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30",
  info: "bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}
