import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react";

/**
 * Page title row. `back` adds a "← Parent" link above the title for sub-pages (e.g. Tables → Table QR codes),
 * matching the hand-written back links on Khata / Loyalty. It is screen-only (print:hidden).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      {back && (
        <Link data-nav="back" href={back.href} className="mb-3 inline-flex min-h-tap items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg print:hidden">
          <ArrowLeft size={18} /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3 pb-5">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </>
  );
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6">{children}</div>;
}
