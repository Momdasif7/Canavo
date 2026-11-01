import type { MealSlot, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { hhmmToMinutes, zonedParts } from "../lib/time";

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
