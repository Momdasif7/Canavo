"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowLeft, FilmSlate } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { clock, publicTheatre, type ScreenPickerPage } from "@/lib/theatre";
import { useCinemaMode } from "@/components/theatre/cinema";
import { ErrorState } from "@/components/ui/States";

/** Screen QR (poster at the screen entrance): the guest picks row, then seat, then orders from that seat's page. */
export default function ScreenSeatPickerPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  useCinemaMode(true);
  const [page, setPage] = useState<ScreenPickerPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [row, setRow] = useState<string | null>(null);
  const [going, setGoing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await publicTheatre.screen(token);
      setPage(p);
      setError(null);
      document.title = `${p.outletName} · ${p.screen.name}`;
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !page)
    return (
      <main className="mx-auto min-h-screen max-w-md bg-bg p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  if (!page)
    return (
      <main className="min-h-screen bg-bg p-5" role="status" aria-label="Opening">
        <div className="mx-auto max-w-md space-y-3">
          <div className="h-6 w-1/2 rounded bg-surface-2" />
          <div className="h-10 w-3/4 rounded bg-surface-2" />
          <div className="grid grid-cols-4 gap-3 pt-6">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="h-16 rounded-2xl bg-surface-2" />
            ))}
          </div>
        </div>
      </main>
    );

  const current = page.rows.find((r) => r.row === row) ?? null;
  return (
    <main className="min-h-screen bg-bg pb-10 text-fg">
      <header className="mx-auto max-w-md px-5 pt-6">
        <p className="text-sm font-semibold text-muted">{page.outletName}</p>
        <h1 className="mt-0.5 flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <FilmSlate size={26} className="text-primary" aria-hidden /> {page.screen.name}
        </h1>
        {page.show && (
          <p className="mt-1 text-sm text-muted">
            {page.show.title} · {clock(page.show.startsAt)}–{clock(page.show.endsAt)}
          </p>
        )}
      </header>

      <section className="mx-auto max-w-md px-5 pt-6" aria-live="polite">
        {!current ? (
          <>
            <h2 className="text-lg font-bold">Which row are you in?</h2>
            <p className="text-sm text-muted">The letter is on the end of your row or on your ticket.</p>
            {page.rows.length === 0 ? (
              <p className="mt-6 rounded-2xl bg-surface p-4 text-sm text-muted">This screen has no seats set up yet. Please order at the counter.</p>
            ) : (
              <div className="mt-4 grid grid-cols-4 gap-3" data-testid="row-picker">
                {page.rows.map((r) => (
                  <button
                    key={r.row}
                    type="button"
                    onClick={() => setRow(r.row)}
                    className="flex h-16 items-center justify-center rounded-2xl border border-line bg-surface text-2xl font-black text-fg active:bg-surface-2"
                  >
                    {r.row}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <button type="button" onClick={() => setRow(null)} className="-ml-2 inline-flex min-h-[48px] items-center gap-2 px-2 text-sm font-semibold text-muted">
              <ArrowLeft size={18} /> All rows
            </button>
            <h2 className="text-lg font-bold">Row {current.row}: which seat?</h2>
            <p className="text-sm text-muted">The number is on your seat or your ticket.</p>
            <div className="mt-4 grid grid-cols-5 gap-2.5" data-testid="seat-picker">
              {current.seats.map((s) => (
                <button
                  key={s.token}
                  type="button"
                  disabled={!!going}
                  onClick={() => {
                    setGoing(s.token);
                    router.push(`/t/${s.token}?c=1`);
                  }}
                  aria-label={`Seat ${current.row}${s.seatNumber}`}
                  className={clsx(
                    "flex h-14 items-center justify-center rounded-xl border text-lg font-extrabold tabular-nums",
                    going === s.token ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-fg active:bg-surface-2",
                  )}
                >
                  {s.seatNumber}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
