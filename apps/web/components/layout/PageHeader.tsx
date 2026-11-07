import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pb-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6">{children}</div>;
}

/**
 * "← Parent" link above a sub-page's PageHeader (same look as the Customers →
 * Khata / Loyalty back links). The accessible name reads "Back to <label>".
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={`Back to ${label}`}
      className="mb-3 inline-flex min-h-tap items-center gap-1.5 rounded-lg text-sm font-semibold text-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <ArrowLeft size={18} aria-hidden="true" /> {label}
    </Link>
  );
}
