"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FloorTable, StaffOption, TableStatus } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";

/** What the floor plan shows: an open tab wins over a stale RESERVED flag; soon-due bookings show as reserved. */
export function visualStatus(t: FloorTable): TableStatus {
  if (t.status === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  if (t.session) return "OCCUPIED";
  if (t.status === "RESERVED" || (t.upcomingReservation && t.upcomingReservation.minutesAway <= 30)) return "RESERVED";
  return "AVAILABLE";
}

export const STATUS_META: Record<TableStatus, { label: string; tile: string; dot: string; emoji: string }> = {
  AVAILABLE: {
    label: "Available",
    emoji: "🟢",
    dot: "bg-green-500",
    tile: "border-green-500 bg-green-50 text-green-950 dark:bg-green-500/15 dark:text-green-50",
  },
  OCCUPIED: {
    label: "Occupied",
    emoji: "🟡",
    dot: "bg-amber-400",
    tile: "border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-400/15 dark:text-amber-50",
  },
  NEEDS_ATTENTION: {
    label: "Needs attention",
    emoji: "🔴",
    dot: "bg-red-500",
    tile: "border-red-500 bg-red-50 text-red-950 animate-pulse dark:bg-red-500/20 dark:text-red-50",
  },
  RESERVED: {
    label: "Reserved",
    emoji: "🔵",
    dot: "bg-sky-500",
    tile: "border-sky-500 bg-sky-50 text-sky-950 dark:bg-sky-500/15 dark:text-sky-50",
  },
};

/**
 * Active staff for waiter pickers. GET /staff needs `staff:view`; roles
 * without it (cashiers) get an empty list and the picker is hidden.
 */
export function useStaffOptions(): StaffOption[] | null {
  const { can, outletId, me } = useSession();
  const allowed = can("staff:view");
  const [list, setList] = useState<StaffOption[] | null>(null);
  useEffect(() => {
    if (!outletId) return;
    if (!allowed) {
      setList(me ? [{ id: me.id, name: me.name, role: me.role }] : []);
      return;
    }
    api
      .get<StaffOption[]>("/staff")
      .then((rows) => setList(rows.filter((s) => (s.status ?? "ACTIVE") === "ACTIVE" && s.role !== "KITCHEN" && s.role !== "DELIVERY")))
      .catch(() => setList([]));
  }, [allowed, outletId, me]);
  return list;
}

export const minutesLabel = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`);
