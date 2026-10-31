import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { SOCKET_TARGET } from "./config";
import type { LowStockEvent, NotificationEvent } from "./types";

/**
 * Single Socket.io connection to the API. Joins `outlet:<id>` (POS/KDS sync)
 * and `user:<id>` (personal notifications) server-side, based on the auth
 * payload.
 */
export interface ServerEvents {
  "kot:new": (kots: unknown[]) => void;
  "kot:updated": (kot: unknown) => void;
  "order:paid": (p: { id: string; invoiceNumber: string }) => void;
  "order:created": (p: { id: string; invoiceNumber: string }) => void;
  notification: (n: NotificationEvent) => void;
  /** Read state changed on another device: one notification or all of them */
  "notification:read": (p: { id?: string; all?: boolean }) => void;
  /** Menu edited (`id`), imported, or items ran out / came back in stock (`ids`, `stock: true`) */
  "menu:changed": (p: { id?: string; ids?: string[]; stock?: boolean; import?: boolean }) => void;
  /** GST / pricing settings of the outlet changed (e.g. GST switched off) */
  "outlet:updated": (p: { id: string; fields: string[] }) => void;
  /** Floor/tab changed (open, items, bill, transfer, merge, close, KOT status…) */
  "table:updated": (p: { tableIds: string[]; sessionId?: string; action: string }) => void;
  /** A running-tab item was voided after its KOT was fired */
  "kot:void": (p: { sessionItemId: string; kotId: string | null; kot: unknown }) => void;
  /** A delivery changed (status, assignment, payment collected, issue, cash handover) */
  "delivery:updated": (d: unknown) => void;
  /** A partner's GPS report (`{ agentId, lat, lng, … }`) */
  "delivery:location": (p: unknown) => void;
  "inventory:low": (p: LowStockEvent) => void;
}

type EventName = keyof ServerEvents;
type Listener = (...args: unknown[]) => void;
/** Untyped view of the emitter, for binding listeners by dynamic event name. */
type Emitter = { on(e: string, l: Listener): unknown; off(e: string, l: Listener): unknown };
const emitter = (s: Socket | null) => s as unknown as Emitter | null;

let socket: Socket | null = null;
let current: { token: string; outletId: string | null } | null = null;
const changeListeners = new Set<() => void>();
const notifyChange = () => changeListeners.forEach((l) => l());

/** Connection state of the current socket (true between `connect` and `disconnect`). */
let connected = false;
const statusListeners = new Set<(connected: boolean) => void>();
function setConnected(next: boolean) {
  connected = next;
  statusListeners.forEach((l) => l(next));
}

export function connectSocket(token: string, outletId: string | null) {
  if (socket && current?.outletId === outletId) {
    // Same room, new access token: use it for the next (re)connect handshake.
    if (current.token !== token) {
      current = { token, outletId };
      socket.auth = { token, outletId };
    }
    return;
  }
  disconnectSocket();
  current = { token, outletId };
  // Origin only: with a gateway base like https://host/api, "/api" would be read as a namespace.
  socket = io(SOCKET_TARGET.url, {
    path: SOCKET_TARGET.path,
    auth: { token, outletId },
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
  });
  // `connect` fires on the first connection and after every automatic reconnect.
  socket.on("connect", () => setConnected(true));
  socket.on("disconnect", () => setConnected(false));
  socket.on("connect_error", () => setConnected(false));
  notifyChange();
}

export function disconnectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  current = null;
  notifyChange();
  if (connected) setConnected(false);
}

export function getSocket() {
  return socket;
}

/** Subscribe to a server event for the lifetime of the component. */
export function useSocketEvent<E extends EventName>(event: E, handler: ServerEvents[E]) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    // The socket is replaced on outlet switch / token refresh, so re-bind on change.
    let bound: Socket | null = null;
    const listener: Listener = (...args) => (ref.current as Listener)(...args);
    const bind = () => {
      if (socket === bound) return;
      emitter(bound)?.off(event, listener);
      bound = socket;
      emitter(bound)?.on(event, listener);
    };
    bind();
    changeListeners.add(bind);
    return () => {
      changeListeners.delete(bind);
      emitter(bound)?.off(event, listener);
    };
  }, [event]);
}

/** Live socket state for indicators ("Live" / "Reconnecting…"). */
export function useSocketConnected(): boolean {
  const [state, setState] = useState(connected);
  useEffect(() => {
    setState(connected);
    statusListeners.add(setState);
    return () => {
      statusListeners.delete(setState);
    };
  }, []);
  return state;
}

/**
 * Run `handler` whenever the socket (re)connects — events emitted while it
 * was down are lost, so screens reload their data here.
 */
export function useSocketReconnect(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (isUp: boolean) => {
      if (isUp) ref.current();
    };
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }, []);
}
