"use client";

import clsx from "clsx";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useConnectivity } from "@/components/providers/ConnectivityProvider";

/** 🟢 Online / 🔴 Offline indicator with the offline-queue count. Tap to sync now. */
export function ConnectivityPill() {
  const { online, pending, failed, syncing, sync } = useConnectivity();
  return (
    <button
      type="button"
      onClick={() => void sync()}
      disabled={!online || !pending}
      title={online ? (pending ? "Sync offline bills now" : "Connected") : "Bills are saved on this device and sync when the connection returns"}
      className={clsx(
        "inline-flex min-h-[40px] items-center gap-2 rounded-full border px-3 text-sm font-semibold",
        online
          ? "border-secondary-100 bg-secondary-50 text-secondary-700 dark:border-secondary/40 dark:bg-secondary/20 dark:text-green-200"
          : "border-red-200 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
      )}
    >
      <span className={clsx("h-2.5 w-2.5 rounded-full", online ? "bg-green-500" : "animate-pulse bg-red-500")} aria-hidden />
      <span>{online ? "Online" : "Offline"}</span>
      {pending > 0 && (
        <span className={clsx("flex items-center gap-1 rounded-full px-2 py-0.5 text-xs", failed ? "bg-red-600 text-white" : "bg-amber-500 text-white")}>
          {syncing && <ArrowsClockwise size={12} className="animate-spin" />}
          {pending} pending
        </span>
      )}
    </button>
  );
}
