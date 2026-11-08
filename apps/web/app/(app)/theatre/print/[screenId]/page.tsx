"use client";

import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Printer } from "@phosphor-icons/react";
import { publicPageUrl } from "@/lib/storefront";
import { seatPart, theatreApi, type Screen, type Seat } from "@/lib/theatre";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

const PER_PAGE = 12;

/**
 * Printable seat QR sheets (A4, 12 per page, 3 × 4, big seat label) and the screen QR poster.
 * The on-screen preview shows the A4 pages; printing sets @page to A4 and prints only the sheets.
 */
export default function TheatrePrintPage() {
  const { screenId } = useParams<{ screenId: string }>();
  const kind = useSearchParams().get("kind") === "poster" ? "poster" : "seats";
  const router = useRouter();
  const { outletId, outlet } = useSession();
  const q = useApiQuery<Screen[]>(outletId ? `theatre-screens:${outletId}` : null, theatreApi.screens);
  const screen = q.data?.find((s) => s.id === screenId);
  const outletName = outlet?.name ?? "";

  // A4 page box only while this page is open (other printouts keep their own page size).
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.theatrePrint = "1";
    style.textContent = "@page { size: A4 portrait; margin: 0; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const seats: Seat[] = screen ? screen.rows.flatMap((r) => r.seats.filter((s) => s.active)) : [];
  const pages: Seat[][] = [];
  for (let i = 0; i < seats.length; i += PER_PAGE) pages.push(seats.slice(i, i + PER_PAGE));

  return (
    <PageContainer>
      <PageHeader
        title={kind === "poster" ? "Screen QR poster" : "Seat QR codes"}
        back={{ href: "/theatre", label: "Screens & seats" }}
        subtitle={
          screen
            ? kind === "poster"
              ? `One A4 poster for the ${screen.name} entrance: guests scan it, pick their row and seat, and order.`
              : `${seats.length} seats of ${screen.name} on ${pages.length} A4 page${pages.length === 1 ? "" : "s"} (12 per page). Cut along the lines and stick one on the back of each seat.`
            : undefined
        }
        actions={
          <>
            <Segmented
              value={kind}
              onChange={(v) => router.replace(v === "poster" ? `/theatre/print/${screenId}?kind=poster` : `/theatre/print/${screenId}`)}
              options={[
                { value: "seats", label: "Seat codes" },
                { value: "poster", label: "Screen poster" },
              ]}
            />
            <Button icon={<Printer size={20} />} onClick={() => window.print()} disabled={!screen || (kind === "seats" && !seats.length)}>
              Print
            </Button>
          </>
        }
      />
      {q.loading && !q.data ? (
        <LoadingState label="Preparing the sheets…" />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !screen ? (
        <EmptyState title="Screen not found" description="It may have been deleted." />
      ) : kind === "poster" ? (
        <div className="print-sheet theatre-sheets">
          <section className="a4-page flex flex-col items-center justify-center gap-[10mm] text-center" data-testid="screen-poster">
            <p className="text-[9mm] font-bold uppercase tracking-[0.2em] text-neutral-500">{outletName}</p>
            <h2 className="text-[22mm] font-black leading-none tracking-tight">{screen.name}</h2>
            <p className="text-[9mm] font-extrabold">Hungry? Order food to your seat</p>
            <div className="rounded-[6mm] border-[1.5mm] border-black p-[6mm]">
              <QRCodeSVG value={publicPageUrl(`/s/${screen.qrToken}`)} size={512} level="M" marginSize={1} style={{ width: "120mm", height: "120mm" }} />
            </div>
            <ol className="space-y-[2mm] text-[7mm] font-semibold">
              <li>1. Scan with your phone camera</li>
              <li>2. Pick your row and seat</li>
              <li>3. Order and pay by UPI — we bring it to you</li>
            </ol>
          </section>
        </div>
      ) : !seats.length ? (
        <EmptyState title="No seats in this screen" description="Add seats first." />
      ) : (
        <div className="print-sheet theatre-sheets" data-testid="seat-sheets">
          {pages.map((page, p) => (
            <section key={p} className="a4-page grid grid-cols-3 grid-rows-4" aria-label={`Page ${p + 1}`}>
              {page.map((s) => (
                <figure key={s.id} className="flex flex-col items-center justify-center gap-[1.5mm] border border-dashed border-neutral-300 p-[3mm] text-center">
                  <figcaption className="max-w-full truncate text-[3mm] font-semibold uppercase tracking-wide text-neutral-500">
                    {outletName} · {screen.name}
                  </figcaption>
                  <QRCodeSVG value={publicPageUrl(`/t/${s.qrToken}?c=1`)} size={256} level="M" marginSize={1} style={{ width: "38mm", height: "38mm" }} />
                  <p className="text-[15mm] font-black leading-none tracking-tight">{seatPart(s.label)}</p>
                  <p className="text-[3.2mm] font-semibold">Scan to order food to your seat</p>
                </figure>
              ))}
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
