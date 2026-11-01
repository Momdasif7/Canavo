import type { MealSlot, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { addDays, hhmmToMinutes, startOfLocalDay, zonedParts } from "../lib/time";

/**
 * Meal slots (Phase 5, CANTEEN module). Shared by slot menus, pre-orders, subscriptions,
 * subsidies and quotas: "which slot is this moment in?".
 */
type Db = Prisma.TransactionClient | typeof prisma;

/** Is `minutes` (minutes after local midnight) inside the slot? Slots may cross midnight. */
export function inSlot(slot: Pick<MealSlot, "startTime" | "endTime">, minutes: number): boolean {
  const from = hhmmToMinutes(slot.startTime);
  const to = hhmmToMinutes(slot.endTime);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The active slot open at `at` in the outlet's timezone, or null. */
export async function slotAt(outletId: string, at: Date, timezone: string, db: Db = prisma): Promise<MealSlot | null> {
  const slots = await db.mealSlot.findMany({ where: { outletId, active: true }, orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }] });
  const minutes = zonedParts(at, timezone).minutes;
  return slots.find((s) => inSlot(s, minutes)) ?? null;
}

/** UTC instant of local time `hhmm` on local date `ymd`. */
export const localInstant = (ymd: string, hhmm: string, timezone: string) => new Date(startOfLocalDay(ymd, timezone).getTime() + hhmmToMinutes(hhmm) * 60_000);

/** When the slot starts on `date` (pre-orders are scheduled for this moment). */
export const slotStartOn = (slot: Pick<MealSlot, "startTime">, date: string, timezone: string) => localInstant(date, slot.startTime, timezone);

/** Pre-orders for `date` close at the slot's cutoff on the previous day; null = the slot takes no pre-orders. */
export const preorderCutoffAt = (slot: Pick<MealSlot, "preorderCutoff">, date: string, timezone: string) =>
  slot.preorderCutoff ? localInstant(addDays(date, -1), slot.preorderCutoff, timezone) : null;

/** Minute ranges of a slot within a day (a slot crossing midnight is two ranges). */
function ranges(slot: Pick<MealSlot, "startTime" | "endTime">): [number, number][] {
  const from = hhmmToMinutes(slot.startTime);
  const to = hhmmToMinutes(slot.endTime);
  return from < to ? [[from, to]] : [[from, 24 * 60], [0, to]];
}

/** Do two slots share any minute? Overlaps are allowed (the first by sort order wins), but worth a warning. */
export function slotsOverlap(a: Pick<MealSlot, "startTime" | "endTime">, b: Pick<MealSlot, "startTime" | "endTime">): boolean {
  return ranges(a).some(([af, at]) => ranges(b).some(([bf, bt]) => af < bt && bf < at));
}

/** Plain-English warnings for active slots that overlap each other. */
export function overlapWarnings(slots: Pick<MealSlot, "id" | "name" | "startTime" | "endTime" | "active">[]): string[] {
  const active = slots.filter((s) => s.active);
  const out: string[] = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++)
      if (slotsOverlap(active[i]!, active[j]!)) out.push(`${active[i]!.name} and ${active[j]!.name} overlap: bills in the shared time go to the one listed first.`);
  return out;
}
