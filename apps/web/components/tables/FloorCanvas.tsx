"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { CalendarBlank, CheckCircle, Timer, Users } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import type { FloorTable, TableShape } from "@/lib/types-service";
import { STATUS_META, minutesLabel, visualStatus } from "./common";

export interface TableBox {
  posX: number;
  posY: number;
  width: number;
  height: number;
  shape: TableShape;
}

const MIN_COLS = 22;
const MIN_ROWS = 12;

/** Cell size that fits `cols` grid columns into the container (clamped for touch). */
function useCellSize(ref: React.RefObject<HTMLDivElement>, cols: number) {
  const [cell, setCell] = useState(40);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setCell(Math.max(34, Math.min(60, Math.floor(entry.contentRect.width / cols)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, cols]);
  return cell;
}

/**
 * Floor plan of one area. Tables are absolutely positioned on a grid
 * (posX/posY/width/height in grid units). In `editable` mode tiles can be
 * dragged (snap to grid) and resized from the corner handle.
 */
export function FloorCanvas({
  tables,
  boxes,
  editable,
  selectedId,
  now,
  onSelect,
  onBoxChange,
}: {
  tables: FloorTable[];
  /** Editor drafts overriding table positions */
  boxes?: Map<string, TableBox>;
  editable?: boolean;
  selectedId?: string | null;
  now: number;
  onSelect: (t: FloorTable) => void;
  onBoxChange?: (id: string, box: TableBox) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const box = (t: FloorTable): TableBox => boxes?.get(t.id) ?? t;
  const cols = Math.max(MIN_COLS, ...tables.map((t) => box(t).posX + box(t).width + 1));
  const rows = Math.max(MIN_ROWS, ...tables.map((t) => box(t).posY + box(t).height + (editable ? 3 : 1)));
  // Size cells from the saved layout so tiles don't rescale mid-drag.
  const baseCols = Math.max(MIN_COLS, ...tables.map((t) => t.posX + t.width + 1));
  const cell = useCellSize(wrapRef, Math.min(baseCols, 30));
  const drag = useRef<{ id: string; kind: "move" | "resize"; startX: number; startY: number; orig: TableBox; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent, t: FloorTable, kind: "move" | "resize") => {
    if (!editable) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, kind, startX: e.clientX, startY: e.clientY, orig: box(t), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onBoxChange) return;
    const dx = Math.round((e.clientX - d.startX) / cell);
    const dy = Math.round((e.clientY - d.startY) / cell);
    if (!dx && !dy && !d.moved) return;
    d.moved = true;
    if (d.kind === "move") onBoxChange(d.id, { ...d.orig, posX: Math.min(500, Math.max(0, d.orig.posX + dx)), posY: Math.min(500, Math.max(0, d.orig.posY + dy)) });
    else onBoxChange(d.id, { ...d.orig, width: Math.min(50, Math.max(1, d.orig.width + dx)), height: Math.min(50, Math.max(1, d.orig.height + dy)) });
  };
  const onPointerUp = (t: FloorTable) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) onSelect(t);
  };

  return (
    <div ref={wrapRef} className="w-full overflow-auto rounded-2xl border border-line bg-surface">
      <div
        className="relative"
        style={{
          width: cols * cell,
          height: rows * cell,
          backgroundImage: editable
            ? "radial-gradient(circle, rgb(var(--line)) 1.5px, transparent 1.5px)"
            : "radial-gradient(circle, rgb(var(--line) / 0.6) 1px, transparent 1px)",
          backgroundSize: `${cell}px ${cell}px`,
          backgroundPosition: `${-cell / 2}px ${-cell / 2}px`,
        }}
        onPointerMove={onPointerMove}
      >
        {tables.map((t) => {
          const b = box(t);
          const status = visualStatus(t);
          const meta = STATUS_META[status];
          const s = t.session;
          const minutes = s ? Math.max(0, Math.floor((now - new Date(s.openedAt).getTime()) / 60_000)) : 0;
          const w = b.width * cell;
          const h = b.height * cell;
          const roomy = w >= 110 && h >= 90;
          return (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              data-table-label={t.label}
              aria-label={`Table ${t.label}, ${meta.label}${s ? `, ${s.guests} guests, ${minutes} minutes, ${formatINR(s.runningTotal)}` : ""}`}
              onPointerDown={(e) => onPointerDown(e, t, "move")}
              onPointerUp={() => onPointerUp(t)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(t);
                }
              }}
              className={clsx(
                "absolute flex select-none flex-col items-center justify-center overflow-hidden border-2 p-1 text-center shadow-sm outline-none transition-shadow",
                "focus-visible:ring-4 focus-visible:ring-primary/40",
                b.shape === "ROUND" ? "rounded-full" : "rounded-xl",
                meta.tile,
                editable ? "cursor-move touch-none" : "cursor-pointer hover:shadow-md",
                selectedId === t.id && "ring-4 ring-primary",
              )}
              style={{ left: b.posX * cell + 3, top: b.posY * cell + 3, width: w - 6, height: h - 6 }}
            >
              <span className="text-lg font-extrabold leading-none">{t.label}</span>
              {editable ? (
                <span className="mt-0.5 text-[11px] font-semibold opacity-70">
                  <Users size={11} className="inline" /> {t.capacity}
                </span>
              ) : s ? (
                <>
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] font-bold">
                    <Timer size={12} /> {minutesLabel(minutes)}
                    <Users size={12} className="ml-0.5" /> {s.guests}
                  </span>
                  <span className="tabular text-xs font-extrabold">{formatINR(s.runningTotal)}</span>
                  {roomy && s.waiter && <span className="max-w-full truncate text-[10px] opacity-80">{s.waiter.name}</span>}
                </>
              ) : (
                <span className="mt-0.5 text-[11px] font-semibold opacity-70">
                  <Users size={11} className="inline" /> {t.capacity}
                </span>
              )}
              {!editable && s?.readyToClose && (
                <span className="absolute right-1 top-1 rounded-full bg-secondary p-0.5 text-white" title="Ready to close">
                  <CheckCircle size={14} weight="fill" />
                </span>
              )}
              {!editable && t.upcomingReservation && (
                <span
                  className="absolute bottom-0.5 left-1/2 flex max-w-[95%] -translate-x-1/2 items-center gap-0.5 truncate rounded-full bg-sky-600 px-1.5 text-[10px] font-bold text-white"
                  title={`${t.upcomingReservation.customerName} · party of ${t.upcomingReservation.partySize}`}
                >
                  <CalendarBlank size={10} />
                  {new Date(t.upcomingReservation.reservedFor).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {editable && (
                <span
                  aria-label={`Resize ${t.label}`}
                  onPointerDown={(e) => onPointerDown(e, t, "resize")}
                  className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize rounded-tl-md bg-primary"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
