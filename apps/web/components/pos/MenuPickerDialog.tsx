"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Armchair, Minus, Plus, ShoppingCartSimple, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { loadMenu } from "@/lib/offline";
import type { Menu, MenuItem } from "@/lib/types";
import { useSession } from "@/components/providers/SessionProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { FoodMark } from "@/components/ui/FoodMark";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { ItemPicker } from "./ItemPicker";
import { MenuBrowser } from "./MenuBrowser";
import { addLine, makeLine, type CartLine } from "./cart";

export interface PickedLine extends CartLine {
  seat?: number;
}

/** Load the active outlet's menu (cached for offline). */
export function useMenu() {
  const { outletId } = useSession();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!outletId) return;
    try {
      setMenu((await loadMenu(outletId)).data);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [outletId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { menu, error, reload };
}

/** Lines keyed by item+variant+addons+seat so different seats stay separate. */
const seatKey = (l: CartLine, seat?: number) => `${l.key}#${seat ?? ""}`;

/**
 * Full-screen menu picker returning a list of lines. With `seats`, a seat
 * selector tags each added line with a seat number (split-by-seat billing).
 */
export function MenuPickerDialog({
  open,
  title,
  confirmLabel,
  seats,
  initial,
  ignoreServingWindow,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** Number of seats to offer (guests); omit to hide the seat selector */
  seats?: number;
  initial?: PickedLine[];
  ignoreServingWindow?: boolean;
  onClose: () => void;
  /** May throw — the error is shown inline */
  onConfirm: (lines: PickedLine[]) => Promise<void> | void;
}) {
  const { outlet } = useSession();
  const { menu, error, reload } = useMenu();
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [seat, setSeat] = useState<number | undefined>(undefined);
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLines(initial ?? []);
      setSeat(undefined);
      setSubmitError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = useCallback(
    (line: CartLine) => {
      setLines((ls) => {
        const tagged: PickedLine = { ...line, key: seatKey(line, seat), seat };
        return addLine(ls, tagged) as PickedLine[];
      });
    },
    [seat],
  );

  const select = useCallback(
    (item: MenuItem) => {
      if (item.variants.length || item.addons.length) setPicker(item);
      else add(makeLine(item));
    },
    [add],
  );

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((l) => m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.quantity));
    return m;
  }, [lines]);

  const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const count = lines.reduce((s, l) => s + l.quantity, 0);

  const confirm = async () => {
    if (!lines.length || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await onConfirm(lines);
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      dismissible={!busy}
      title={title}
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-sm text-muted">
            {count} item{count === 1 ? "" : "s"} · <strong className="tabular text-fg">{formatINR(total)}</strong>
          </span>
          <Button variant="ghost" className="ml-auto" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="lg" onClick={confirm} loading={busy} disabled={!lines.length}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {!menu ? (
        error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <LoadingState label="Loading menu…" />
        )
      ) : (
        <div className="-mx-5 -my-4 flex h-[68vh] min-h-0 flex-col md:flex-row">
          <MenuBrowser
            menu={menu}
            qtyByItem={qtyByItem}
            onSelect={select}
            timezone={outlet?.timezone}
            ignoreServingWindow={ignoreServingWindow}
            dense
            header={
              seats ? (
                <div className="flex items-center gap-2 overflow-x-auto border-b border-line bg-surface px-3 py-2" role="radiogroup" aria-label="Seat">
                  <Armchair size={20} className="shrink-0 text-muted" />
                  <span className="shrink-0 text-sm font-semibold text-muted">Seat</span>
                  {[undefined, ...Array.from({ length: Math.min(seats, 20) }, (_, i) => i + 1)].map((s) => (
                    <button
                      key={s ?? "shared"}
                      type="button"
                      role="radio"
                      aria-checked={seat === s}
                      onClick={() => setSeat(s)}
                      className={clsx(
                        "min-h-[40px] min-w-[44px] shrink-0 rounded-lg border px-3 text-sm font-bold",
                        seat === s ? "border-secondary bg-secondary text-white" : "border-line bg-surface hover:border-secondary/60",
                      )}
                    >
                      {s ?? "Shared"}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
          />
          <aside className="flex max-h-[35%] shrink-0 flex-col border-t border-line bg-surface md:max-h-none md:w-[300px] md:border-l md:border-t-0">
            <p className="border-b border-line px-3 py-2 text-sm font-bold">Selected</p>
            {submitError && (
              <div className="p-2">
                <Alert>{submitError}</Alert>
              </div>
            )}
            {lines.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
                <ShoppingCartSimple size={36} weight="duotone" />
                Tap items to add them
              </div>
            ) : (
              <ul className="scrollbar-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
                {lines.map((l) => (
                  <li key={l.key} className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      <FoodMark type={l.foodType} size={12} className="mt-1" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {l.name}
                          {l.variantName && <span className="font-normal text-muted"> ({l.variantName})</span>}
                        </p>
                        {l.addonNames.length > 0 && <p className="truncate text-xs text-muted">+ {l.addonNames.join(", ")}</p>}
                        {seats ? <p className="text-xs font-semibold text-secondary dark:text-green-300">{l.seat ? `Seat ${l.seat}` : "Shared"}</p> : null}
                      </div>
                      <span className="tabular text-sm font-bold">{formatINR(l.unitPrice * l.quantity)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <IconButton
                        label={`Decrease ${l.name}`}
                        className="min-h-[36px] min-w-[36px]"
                        onClick={() => setLines((ls) => ls.flatMap((x) => (x.key === l.key ? (x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : []) : [x])))}
                      >
                        <Minus size={14} weight="bold" />
                      </IconButton>
                      <span className="tabular w-6 text-center text-sm font-bold">{l.quantity}</span>
                      <IconButton
                        label={`Increase ${l.name}`}
                        className="min-h-[36px] min-w-[36px]"
                        onClick={() => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(999, x.quantity + 1) } : x)))}
                      >
                        <Plus size={14} weight="bold" />
                      </IconButton>
                      <input
                        aria-label={`Note for ${l.name}`}
                        placeholder="Note"
                        maxLength={200}
                        value={l.notes}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, notes: e.target.value } : x)))}
                        className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-xs focus:border-primary focus:outline-none"
                      />
                      <IconButton label={`Remove ${l.name}`} className="min-h-[36px] min-w-[36px] text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <Trash size={16} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
      <ItemPicker item={picker} onClose={() => setPicker(null)} onAdd={add} />
    </Dialog>
  );
}
