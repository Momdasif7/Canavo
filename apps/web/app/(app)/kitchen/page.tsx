"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowRight, Printer, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { ORDER_TYPE_LABELS, formatTime } from "@/lib/format";
import { getKotPaperWidth } from "@/lib/prefs";
import { printReceiptText } from "@/lib/print";
import type { Kot, KotStatus } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent, useSocketStatus } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { IconButton } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { ChannelBadge } from "@/components/bills/ChannelBadge";

const COLUMNS: { status: KotStatus; title: string; accent: string }[] = [
  { status: "RECEIVED", title: "Received", accent: "bg-sky-500" },
  { status: "PREPARING", title: "Preparing", accent: "bg-primary" },
  { status: "READY", title: "Ready", accent: "bg-secondary" },
];

const NEXT: Record<KotStatus, KotStatus | null> = { RECEIVED: "PREPARING", PREPARING: "READY", READY: "SERVED", SERVED: null };
const NEXT_LABEL: Record<KotStatus, string> = { RECEIVED: "Start", PREPARING: "Ready", READY: "Served", SERVED: "" };
const SOUND_KEY = "canavo.kdsSound";
/** Fallback refresh while the socket is quiet or down. */
const POLL_MS = 15_000;

/** Short two-tone beep via Web Audio (no asset needed). */
function beep(ctx: AudioContext) {
  [880, 1175].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.18;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.17);
  });
}

export default function KitchenPage() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const canUpdate = can("kot:update");
  const kots = useApiQuery<Kot[]>(outletId ? `kot:${outletId}` : null, () => api.get<Kot[]>("/kot"));
  const [station, setStation] = useState<string>("ALL");
  const [sound, setSound] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const now = useNow(1000);
  const live = useSocketStatus();
  /** New tickets per station that arrived while that station was filtered out. */
  const [unseen, setUnseen] = useState<Record<string, number>>({});
  /** Ticket ids already on screen (null until the first load) — used to detect arrivals from any source. */
  const knownIds = useRef<Set<string> | null>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const stationRef = useRef(station);
  stationRef.current = station;

  useEffect(() => {
    try {
      setSound(localStorage.getItem(SOUND_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSound = () => {
    // Audio must be unlocked by a user gesture, so create the context here.
    audioRef.current ??= new AudioContext();
    void audioRef.current.resume();
    const next = !sound;
    setSound(next);
    if (next) beep(audioRef.current);
    try {
      localStorage.setItem(SOUND_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const { reload, setData } = kots;

  // Detect new tickets however they arrive (socket event, reconnect reload, poll) and beep once per batch.
  useEffect(() => {
    if (!kots.data) return;
    const known = knownIds.current;
    const fresh = known ? kots.data.filter((k) => !known.has(k.id) && k.status !== "SERVED") : [];
    knownIds.current = new Set([...(known ?? []), ...kots.data.map((k) => k.id)]);
    if (!fresh.length) return;
    if (soundRef.current) {
      try {
        audioRef.current ??= new AudioContext();
        beep(audioRef.current);
      } catch {
        /* audio unavailable */
      }
    }
    const current = stationRef.current;
    if (current !== "ALL") {
      const hidden = fresh.filter((k) => k.station !== current);
      if (hidden.length) {
        setUnseen((u) => {
          const next = { ...u };
          for (const k of hidden) next[k.station] = (next[k.station] ?? 0) + 1;
          return next;
        });
      }
    }
  }, [kots.data]);

  const chooseStation = (s: string) => {
    setStation(s);
    setUnseen((u) => (s === "ALL" ? {} : { ...u, [s]: 0 }));
  };

  useSocketEvent("kot:new", () => void reload());
  // (Re)connected: catch up on anything sent while the socket was down.
  useSocketEvent("connect", () => void reload());
  useSocketEvent<Kot>("kot:updated", (k) => {
    setData((list) => {
      if (!list) return list;
      if (k.status === "SERVED") return list.filter((x) => x.id !== k.id);
      return list.some((x) => x.id === k.id) ? list.map((x) => (x.id === k.id ? k : x)) : [...list, k];
    });
  });
  useSocketEvent("order:cancelled", () => void reload());
  // A running-tab item was voided: strike it through on its ticket.
  useSocketEvent<{ sessionItemId: string; kotId: string | null; kot: Kot | null }>("kot:void", (e) => {
    setData((list) => {
      if (!list) return list;
      if (e.kot) return list.map((x) => (x.id === e.kot!.id ? { ...x, items: e.kot!.items } : x));
      return list.map((x) => (x.id === e.kotId ? { ...x, items: x.items.map((it) => (it.sessionItemId === e.sessionItemId ? { ...it, voided: true } : it)) } : x));
    });
  });

  // Fallback refresh in case socket events were missed (tablet slept, flaky Wi-Fi), plus
  // an immediate catch-up when the tab becomes visible again or the network returns.
  useEffect(() => {
    const id = window.setInterval(() => void reload(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const onOnline = () => void reload();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [reload]);

  const advance = useCallback(
    async (kot: Kot) => {
      const next = NEXT[kot.status];
      if (!next || !canUpdate) return;
      const prev = kots.data;
      setData((list) => (next === "SERVED" ? list?.filter((x) => x.id !== kot.id) : list?.map((x) => (x.id === kot.id ? { ...x, status: next } : x))));
      try {
        await api.patch(`/kot/${kot.id}`, { status: next });
      } catch (e) {
        setData(prev);
        toast(errorMessage(e), "error");
      }
    },
    [canUpdate, kots.data, setData, toast],
  );

  const print = async (kot: Kot) => {
    try {
      const res = await api.post<{ text: string }>(`/kot/${kot.id}/print`);
      printReceiptText(res.text, getKotPaperWidth(), "kot");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const stations = useMemo(() => {
    const set = new Set((kots.data ?? []).map((k) => k.station));
    // Keep the selected station's chip even when it has no open tickets right now.
    if (station !== "ALL") set.add(station);
    return [...set].sort();
  }, [kots.data, station]);
  // Tickets whose every item was voided have nothing left to cook.
  const visible = (kots.data ?? []).filter((k) => (station === "ALL" || k.station === station) && !(k.items.length > 0 && k.items.every((i) => i.voided)));

  if (kots.loading && !kots.data) return <LoadingState label="Loading kitchen tickets…" />;
  if (kots.error && !kots.data) return <ErrorState message={kots.error} onRetry={reload} />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <h1 className="mr-2 text-xl font-extrabold">Kitchen</h1>
        <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Station">
          {["ALL", ...stations].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={station === s}
              onClick={() => chooseStation(s)}
              className={clsx(
                "relative flex min-h-tap shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-bold",
                station === s ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface hover:border-primary/60",
              )}
            >
              {s === "ALL" ? "All stations" : s}
              {station !== s && (unseen[s] ?? 0) > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 text-xs font-extrabold text-white" aria-label={`${unseen[s]} new`}>
                  {unseen[s]} new
                </span>
              )}
            </button>
          ))}
        </div>
        <span
          role="status"
          className={clsx(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold",
            live ? "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
          )}
          title={live ? "New tickets appear instantly" : "Connection lost — checking for new tickets every 15 s"}
        >
          <span className={clsx("h-2 w-2 rounded-full", live ? "bg-green-500" : "animate-pulse bg-amber-500")} />
          {live ? "Live" : "Reconnecting…"}
        </span>
        <IconButton label={sound ? "Mute new-ticket sound" : "Enable new-ticket sound"} onClick={toggleSound} className={clsx(sound && "text-primary")}>
          {sound ? <SpeakerHigh size={26} weight="fill" /> : <SpeakerSlash size={26} />}
        </IconButton>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 md:grid-cols-3 md:overflow-hidden">
        {COLUMNS.map((col) => {
          const items = visible.filter((k) => k.status === col.status);
          return (
            <section key={col.status} className="flex min-h-0 flex-col rounded-2xl bg-surface-2" aria-label={col.title}>
              <header className="flex items-center gap-2 px-4 py-3">
                <span className={clsx("h-3 w-3 rounded-full", col.accent)} />
                <h2 className="font-bold">{col.title}</h2>
                <span className="ml-auto rounded-full bg-surface px-2.5 py-0.5 text-sm font-bold">{items.length}</span>
              </header>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
                {items.length === 0 && <p className="py-10 text-center text-sm text-muted">Nothing here</p>}
                {items.map((k) => (
                  <KotCard key={k.id} kot={k} now={now} canUpdate={canUpdate} onAdvance={advance} onPrint={print} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function KotCard({
  kot,
  now,
  canUpdate,
  onAdvance,
  onPrint,
}: {
  kot: Kot;
  now: number;
  canUpdate: boolean;
  onAdvance: (k: Kot) => void;
  onPrint: (k: Kot) => void;
}) {
  const elapsedSec = Math.max(0, Math.floor((now - new Date(kot.createdAt).getTime()) / 1000));
  const mins = Math.floor(elapsedSec / 60);
  const level = mins >= 20 ? "late" : mins >= 10 ? "warn" : "ok";
  const timer = `${mins}:${String(elapsedSec % 60).padStart(2, "0")}`;

  return (
    <article
      className={clsx(
        "overflow-hidden rounded-xl border-2 bg-surface shadow-sm",
        level === "late" ? "border-red-500" : level === "warn" ? "border-amber-400" : "border-transparent",
      )}
    >
      <div
        className={clsx(
          "flex items-center gap-2 px-3 py-2",
          level === "late" ? "bg-red-500 text-white" : level === "warn" ? "bg-amber-400 text-black" : "bg-surface-2",
        )}
      >
        <span className="text-lg font-extrabold">#{kot.kotNumber}</span>
        <span className="rounded bg-black/10 px-1.5 text-xs font-bold uppercase">{kot.station}</span>
        <span className="tabular ml-auto text-lg font-extrabold" aria-label={`${mins} minutes elapsed`}>
          {timer}
        </span>
      </div>
      <button
        type="button"
        disabled={!canUpdate}
        onClick={() => onAdvance(kot)}
        className="block w-full px-3 py-2 text-left disabled:cursor-default"
        aria-label={canUpdate ? `Mark KOT ${kot.kotNumber} as ${NEXT_LABEL[kot.status]}` : undefined}
      >
        {kot.order?.scheduledFor && (
          <p className="mb-1.5 inline-flex items-center gap-1 rounded-lg bg-violet-100 px-2 py-0.5 text-sm font-extrabold uppercase tracking-wide text-violet-800 dark:bg-violet-500/20 dark:text-violet-200">
            Pre-order for {formatTime(kot.order.scheduledFor)}
            {kot.order.customerName && <span className="font-semibold normal-case"> · {kot.order.customerName}</span>}
          </p>
        )}
        <p className="mb-1 text-sm text-muted">
          {kot.session ? (
            <>
              Dine-In · <strong className="text-base text-fg">Table {kot.session.tableLabel}</strong>
              {!kot.order && <span> · Running tab</span>}
            </>
          ) : (
            <>
              {kot.order ? ORDER_TYPE_LABELS[kot.order.orderType] : ""}
              {kot.order?.tableLabel && <strong className="text-fg"> · Table {kot.order.tableLabel}</strong>}
            </>
          )}
          {kot.order && <span> · {kot.order.invoiceNumber}</span>}
          <ChannelBadge channel={kot.order?.channel} className="ml-2" />
        </p>
        <ul className="space-y-1">
          {kot.items.map((it, i) => (
            <li key={i} className={clsx(it.voided && "text-muted line-through decoration-2 decoration-red-500")} aria-label={it.voided ? `${it.name} (voided)` : undefined}>
              {it.voided && <span className="mr-1 rounded bg-red-600 px-1 text-[11px] font-bold uppercase text-white no-underline">Void</span>}
              <span className="text-lg font-bold">
                <span className="tabular mr-2 inline-block min-w-[2ch] text-primary">{it.quantity}×</span>
                {it.name}
              </span>
              {it.addons?.map((a) => (
                <span key={a} className="block pl-8 text-sm text-muted">
                  + {a}
                </span>
              ))}
              {it.notes && <span className="block pl-8 text-sm font-semibold text-red-600 dark:text-red-300">! {it.notes}</span>}
            </li>
          ))}
        </ul>
        {kot.order?.notes && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm dark:bg-amber-500/10">Note: {kot.order.notes}</p>}
      </button>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
        <IconButton label="Print KOT" onClick={() => onPrint(kot)}>
          <Printer size={22} />
        </IconButton>
        {canUpdate && (
          <button
            type="button"
            onClick={() => onAdvance(kot)}
            className="ml-auto flex min-h-tap items-center gap-2 rounded-xl bg-secondary px-4 font-bold text-white hover:bg-secondary-600"
          >
            {NEXT_LABEL[kot.status]} <ArrowRight size={18} weight="bold" />
          </button>
        )}
      </div>
    </article>
  );
}
