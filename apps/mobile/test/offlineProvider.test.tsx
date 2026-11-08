/** <OfflineProvider>: queue while offline, flush on reconnect, back off while the server fails. */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { api } from "../src/lib/api";
import { OfflineProvider, useOffline } from "../src/offline/OfflineContext";
import { bill, fakeServer } from "./fakeServer";
import { tokens } from "./helpers";

jest.mock("../src/auth/AuthContext", () => ({ useAuth: () => ({ status: "signedIn" }) }));

describe("<OfflineProvider>", () => {
  afterEach(() => jest.useRealTimers());

  function Probe() {
    const o = useOffline();
    return (
      <>
        <Text testID="state">{`${o.online ? "on" : "off"}|${o.pendingCount}|${o.failed.length}|${o.lastError ?? ""}`}</Text>
        <Pressable testID="enqueue" onPress={() => void o.enqueue(bill(`p-${Date.now()}-${Math.random()}`))} />
      </>
    );
  }

  it("queues while offline, flushes when the connection returns, backs off while the server fails", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    await api.setTokens(tokens);
    const server = fakeServer();
    const net = (globalThis as unknown as { __NETINFO__: { emit: (s: object) => void } }).__NETINFO__;

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>,
    );
    await act(async () => net.emit({ isConnected: false, isInternetReachable: false }));
    await act(async () => fireEvent.press(screen.getByTestId("enqueue")));
    await act(async () => fireEvent.press(screen.getByTestId("enqueue")));
    expect(screen.getByTestId("state").props.children).toBe("off|2|0|");

    // Connection is back but the server is erroring: first pass fails…
    server.set("500");
    await act(async () => net.emit({ isConnected: true, isInternetReachable: true }));
    expect(screen.getByTestId("state").props.children).toBe("on|2|0|Internal error");
    const syncCalls = () => server.calls.filter((c) => c.path === "/orders/sync").length;
    const afterFirst = syncCalls();
    // …so the next automatic try waits 60 s, not 30 s.
    await act(async () => void (await jest.advanceTimersByTimeAsync(31_000)));
    expect(syncCalls()).toBe(afterFirst);
    server.set("up");
    await act(async () => void (await jest.advanceTimersByTimeAsync(30_000)));
    expect(syncCalls()).toBe(afterFirst + 1);
    expect(screen.getByTestId("state").props.children).toBe("on|0|0|");
    expect(server.orders.size).toBe(2);
  });
});
