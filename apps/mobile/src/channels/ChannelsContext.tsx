import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import { useAuth } from "../auth/AuthContext";
import { canHandleChannelRequests, canViewChannelBoard } from "../auth/access";
import { ApiError, endpoints, errorMessage } from "../lib/api";
import { useSocketEvent, useSocketReconnect } from "../lib/socket";
import type { ChannelRequest } from "../lib/types";

/**
 * Phase 6 (CHANNELS): the queue of QR / online orders waiting for a waiter or cashier to
 * accept them. Lives above the tabs so the Online tab can show a badge count and staff get
 * a buzz on a new request whichever tab is open. Also remembers a module-off 403 so the tab
 * hides when the business switches the module off while the app is open.
 */
interface ChannelsState {
  /** Pending requests (oldest first); null until loaded or when the user can't handle them */
  requests: ChannelRequest[] | null;
  requestsError: string | null;
  /** The user may accept / reject requests */
  canHandle: boolean;
  /** The user may see the order board */
  canBoard: boolean;
  /** The API said the CHANNELS module is off for this business */
  off: boolean;
  markOff: () => void;
  reload: () => Promise<void>;
  accept: (id: string) => Promise<void>;
  reject: (id: string, reason: string) => Promise<void>;
}

const ChannelsContext = createContext<ChannelsState | null>(null);

/** Fallback poll: socket events can be missed (flaky Wi-Fi, background). */
const POLL_MS = 30_000;
export const NEW_ORDER_VIBRATION = [0, 400, 200, 400];

export function ChannelsProvider({ children }: { children: React.ReactNode }) {
  const { access, outlet, status } = useAuth();
  const signedIn = status === "signedIn" && !!outlet;
  const canHandle = signedIn && canHandleChannelRequests(access);
  const canBoard = signedIn && canViewChannelBoard(access);
  const [requests, setRequests] = useState<ChannelRequest[] | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  /** Request ids already seen; null until the first load sets the baseline (no buzz for old ones). */
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!canHandle) return;
    try {
      const list = await endpoints.channelRequests();
      const pending = list.filter((r) => r.status === "PENDING");
      setRequests(pending);
      setRequestsError(null);
      setOff(false);
      const set = seen.current;
      if (!set) seen.current = new Set(pending.map((r) => r.id));
      else {
        const fresh = pending.filter((r) => !set.has(r.id));
        fresh.forEach((r) => set.add(r.id));
        if (fresh.length) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Vibration.vibrate(NEW_ORDER_VIBRATION);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.isModuleDisabled) {
        setOff(true);
        setRequests([]);
      } else setRequestsError(errorMessage(e));
    }
  }, [canHandle]);

  useEffect(() => {
    setRequests(null);
    setOff(false);
    seen.current = null;
    if (!canHandle) return;
    void load();
    const poll = setInterval(load, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void load();
    });
    return () => {
      clearInterval(poll);
      sub.remove();
    };
  }, [load, canHandle, outlet?.id]);

  useSocketReconnect(() => {
    void load();
  });
  useSocketEvent("channel:request", () => {
    void load();
  });

  const accept = useCallback(
    async (id: string) => {
      try {
        await endpoints.acceptChannelRequest(id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setRequests((cur) => (cur ? cur.filter((r) => r.id !== id) : cur));
      } finally {
        void load();
      }
    },
    [load],
  );

  const reject = useCallback(
    async (id: string, reason: string) => {
      try {
        await endpoints.rejectChannelRequest(id, reason);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setRequests((cur) => (cur ? cur.filter((r) => r.id !== id) : cur));
      } finally {
        void load();
      }
    },
    [load],
  );

  const markOff = useCallback(() => setOff(true), []);

  const value = useMemo<ChannelsState>(
    () => ({ requests, requestsError, canHandle, canBoard, off, markOff, reload: load, accept, reject }),
    [requests, requestsError, canHandle, canBoard, off, markOff, load, accept, reject],
  );
  return <ChannelsContext.Provider value={value}>{children}</ChannelsContext.Provider>;
}

export function useChannels(): ChannelsState {
  const ctx = useContext(ChannelsContext);
  if (!ctx) throw new Error("useChannels must be used inside <ChannelsProvider>");
  return ctx;
}
