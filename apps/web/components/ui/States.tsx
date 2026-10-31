import { LockSimple, WarningCircle, Tray } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted" role="status">
      <Spinner className="h-8 w-8 text-primary" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Tray size={40} className="text-muted" weight="duotone" />
      <p className="font-semibold text-fg">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A feature the business hasn't subscribed to (API 403 "not enabled for your business"). */
export function ModuleOffState({ feature, description }: { feature?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" role="status">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <LockSimple size={30} weight="duotone" />
      </span>
      <p className="mt-1 font-bold text-fg">{feature ? `${feature} isn't enabled for your business` : "Not enabled for your business"}</p>
      <p className="max-w-sm text-sm text-muted">
        {description ?? "This module is not part of your CANAVO plan. Contact your CANAVO administrator to switch it on."}
      </p>
    </div>
  );
}

const MODULE_OFF = /not enabled for your business/i;

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (MODULE_OFF.test(message)) return <ModuleOffState />;
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center" role="alert">
      <WarningCircle size={40} className="text-red-500" weight="duotone" />
      <p className="max-w-md text-sm font-medium text-fg">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = "danger", children }: { tone?: "danger" | "warning" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        : "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${cls}`} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}
