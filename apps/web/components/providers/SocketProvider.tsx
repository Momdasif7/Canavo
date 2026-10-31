"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, getSession, refreshAccessToken } from "@/lib/api";
import { useSession } from "./SessionProvider";

const SocketContext = createContext<Socket | null>(null);
/** True while the socket is connected (live events are flowing). */
const SocketStatusContext = createContext(false);

/**
 * One socket per (user, outlet). The auth payload is a function so every
 * reconnect presents the latest access token; an "unauthorized" handshake
 * triggers a token refresh before the next attempt.
 *
 * Deps are deliberately stable (user id, not the `me` object): refreshing the
 * session profile must not tear the socket down, or events in the gap are lost.
 */
export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { status, outletId, me } = useSession();
  const userId = me?.id ?? null;
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (status !== "authenticated" || !outletId || !userId) return;
    // Behind a gateway the API is a path ("/api"): socket.io must connect to the page's origin
    // with its default /socket.io path, otherwise "/api" would be taken as a namespace.
    const s = io(API_URL.startsWith("/") ? window.location.origin : API_URL, {
      auth: (cb) => cb({ token: getSession()?.accessToken ?? "", outletId }),
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 10_000,
    });
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("connect_error", async (err) => {
      setConnected(false);
      if (err.message !== "unauthorized") return;
      try {
        const fresh = await refreshAccessToken(getSession()?.accessToken);
        if (fresh) s.connect();
      } catch {
        /* offline — socket.io keeps retrying */
      }
    });
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [status, outletId, userId]);

  return (
    <SocketContext.Provider value={socket}>
      <SocketStatusContext.Provider value={connected}>{children}</SocketStatusContext.Provider>
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);

/** Live connection state of the outlet socket ("Live" vs "Reconnecting…"). */
export const useSocketStatus = () => useContext(SocketStatusContext);

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const socket = useSocket();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!socket) return;
    const fn = (payload: T) => ref.current(payload);
    socket.on(event, fn);
    return () => {
      socket.off(event, fn);
    };
  }, [socket, event]);
}
