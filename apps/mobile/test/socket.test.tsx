/** Socket: reconnect → screens refetch; listeners re-bind when the socket is replaced; token refresh keeps the room. */
import React from "react";
import { act, render, renderHook } from "@testing-library/react-native";

type Handler = (...a: unknown[]) => void;
class MockSocket {
  handlers = new Map<string, Set<Handler>>();
  auth: unknown;
  connected = false;
  disconnect = jest.fn(() => this.fire("disconnect"));
  constructor(public url: string, public opts: { auth: unknown }) {
    this.auth = opts.auth;
  }
  on(e: string, h: Handler) {
    (this.handlers.get(e) ?? this.handlers.set(e, new Set()).get(e)!).add(h);
    return this;
  }
  off(e: string, h: Handler) {
    this.handlers.get(e)?.delete(h);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  fire(e: string, ...a: unknown[]) {
    if (e === "connect") this.connected = true;
    if (e === "disconnect") this.connected = false;
    this.handlers.get(e)?.forEach((h) => h(...a));
  }
}
const mockSockets: MockSocket[] = [];
jest.mock("socket.io-client", () => ({
  io: (url: string, opts: { auth: unknown }) => {
    const s = new MockSocket(url, opts);
    mockSockets.push(s);
    return s;
  },
}));

import { connectSocket, disconnectSocket, useSocketConnected, useSocketEvent, useSocketReconnect } from "../src/lib/socket";

afterEach(() => {
  act(() => disconnectSocket());
  mockSockets.length = 0;
});

describe("socket", () => {
  it("each (re)connect triggers the refetch handler; 'Live' indicator follows the connection", () => {
    const refetch = jest.fn();
    const { result } = renderHook(() => {
      useSocketReconnect(refetch);
      return useSocketConnected();
    });
    act(() => connectSocket("t1", "o1"));
    const s = mockSockets[0];
    expect(s.opts).toMatchObject({ auth: { token: "t1", outletId: "o1" }, reconnection: true, transports: ["websocket"] });
    act(() => s.fire("connect"));
    expect(result.current).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    act(() => s.fire("disconnect", "transport close"));
    expect(result.current).toBe(false);
    act(() => s.fire("connect_error", new Error("down")));
    expect(refetch).toHaveBeenCalledTimes(1);
    act(() => s.fire("connect")); // automatic reconnect
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(true);
  });

  it("new access token for the same outlet → same socket, auth updated for the next handshake", () => {
    act(() => connectSocket("t1", "o1"));
    act(() => connectSocket("t2", "o1"));
    expect(mockSockets).toHaveLength(1);
    expect(mockSockets[0].auth).toEqual({ token: "t2", outletId: "o1" });
  });

  it("outlet switch → old socket closed, event listeners re-bound to the new one", () => {
    const onKot = jest.fn();
    function Kds() {
      useSocketEvent("kot:new", onKot);
      return null;
    }
    render(<Kds />);
    act(() => connectSocket("t1", "o1"));
    act(() => mockSockets[0].fire("kot:new", [{ id: "k1" }]));
    act(() => connectSocket("t1", "o2"));
    expect(mockSockets[0].disconnect).toHaveBeenCalled();
    act(() => mockSockets[0].fire("kot:new", [{ id: "stale" }])); // old room: ignored
    act(() => mockSockets[1].fire("kot:new", [{ id: "k2" }]));
    expect(onKot.mock.calls.map((c) => (c[0] as { id: string }[])[0].id)).toEqual(["k1", "k2"]);
  });

  it("logout → disconnected, indicator off, no more events", () => {
    const onPaid = jest.fn();
    const { result } = renderHook(() => {
      useSocketEvent("order:paid", onPaid);
      return useSocketConnected();
    });
    act(() => connectSocket("t1", "o1"));
    act(() => mockSockets[0].fire("connect"));
    act(() => disconnectSocket());
    expect(result.current).toBe(false);
    act(() => mockSockets[0].fire("order:paid", { id: "x" }));
    expect(onPaid).not.toHaveBeenCalled();
  });
});
