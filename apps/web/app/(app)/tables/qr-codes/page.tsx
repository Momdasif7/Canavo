"use client";

import { useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ArrowsClockwise, Printer } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { publicPageUrl, type TableQr } from "@/lib/storefront";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert, EmptyState, ErrorState, LoadingState, ModuleOffState } from "@/components/ui/States";

/** Phase 6.3: printable QR code per table (guests scan it to see the menu and order). */
export default function TableQrCodesPage() {
  const { outletId, can, outlet } = useSession();
  const allowed = can("channel:manage");
  const q = useApiQuery<TableQr[]>(allowed && outletId ? `table-qr:${outletId}` : null, () => api.get<TableQr[]>("/storefront/tables"));
  const [rotating, setRotating] = useState<TableQr | null>(null);
  const toast = useToast();
  const outletName = outlet?.name ?? "";

  if (!allowed) return <PageContainer><ModuleOffState feature="QR table ordering" description="QR codes come with the Online orders & channels module." /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader
        title="Table QR codes"
        back={{ href: "/tables", label: "Tables" }}
        subtitle="Print and stick one on each table. Guests scan it to see the menu, order and call a waiter."
        actions={
          <Button icon={<Printer size={20} />} onClick={() => window.print()} disabled={!q.data?.length}>
            Print all
          </Button>
        }
      />
      <div className="mb-4 max-w-3xl">
        <Alert tone="info">
          Guests can only order when QR ordering is on in{" "}
          <Link href="/settings/online-ordering" className="font-semibold underline">
            Settings → Online ordering
          </Link>
          ; otherwise the code shows the menu. If a code is misused, make a new one — the old printout stops working.
        </Alert>
      </div>
      {q.loading && !q.data ? (
        <LoadingState label="Loading tables…" />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !q.data?.length ? (
        <EmptyState title="No tables yet" description="Add tables in Tables → Edit floor first." />
      ) : (
        <div className="print-sheet grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3 print:gap-6">
          {q.data.map((t) => (
            <figure key={t.id} className="flex break-inside-avoid flex-col items-center gap-2 rounded-2xl border border-line bg-white p-4 text-center text-black">
              <figcaption className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{outletName}</figcaption>
              <QRCodeSVG value={publicPageUrl(`/t/${t.qrToken}`)} size={160} level="M" marginSize={1} />
              <p className="text-2xl font-extrabold">Table {t.label}</p>
              <p className="text-sm text-neutral-600">Scan to see the menu &amp; order</p>
              <Button size="sm" variant="ghost" className="text-neutral-700 print:hidden" icon={<ArrowsClockwise size={16} />} onClick={() => setRotating(t)}>
                New code
              </Button>
            </figure>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!rotating}
        title={`New QR code for table ${rotating?.label ?? ""}?`}
        description="The printed code on this table stops working. Print and stick the new one."
        confirmLabel="Make new code"
        onClose={() => setRotating(null)}
        onConfirm={async () => {
          try {
            await api.post(`/storefront/tables/${rotating!.id}/rotate`);
            toast(`New code for table ${rotating!.label} — print it now`, "success");
            setRotating(null);
            void q.reload();
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
    </PageContainer>
  );
}
