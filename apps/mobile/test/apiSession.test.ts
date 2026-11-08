/** API client session handling behind login: token storage, single-flight refresh, session expiry, idempotency. */
import * as SecureStore from "expo-secure-store";
import { mockFetch } from "./helpers";

const { api, ApiError } = require("../src/lib/api") as typeof import("../src/lib/api");

describe("API session", () => {
  it("setTokens persists the session (restore after an app restart)", async () => {
    await api.setTokens({ accessToken: "a1", refreshToken: "r1", expiresIn: 900 });
    expect(await SecureStore.getItemAsync("canavo.refreshToken")).toBe("r1");
    await api.clear();
    expect(api.hasSession).toBe(false);
    await api.setTokens({ accessToken: "a1", refreshToken: "r1", expiresIn: 900 });
    expect(await api.restore()).toBe(true);
    expect(api.getAccessTokenSync()).toBe("a1");
  });

  it("401 on concurrent calls → exactly one refresh (rotated refresh tokens), both retried with the same idempotency key", async () => {
    await api.setTokens({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });
    let refreshes = 0;
    const calls = mockFetch(async (c) => {
      if (c.path === "/auth/refresh") {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, body: { accessToken: "new", refreshToken: "r2", expiresIn: 900 } };
      }
      return c.headers.Authorization === "Bearer new" ? { status: 200, body: { ok: true } } : { status: 401, body: { error: "jwt expired" } };
    });
    await Promise.all([api.get("/a"), api.post("/b", { x: 1 }), api.get("/c")]);
    expect(refreshes).toBe(1);
    const posts = calls.filter((c) => c.path === "/b");
    expect(posts).toHaveLength(2);
    expect(posts[0].headers["Idempotency-Key"]).toBe(posts[1].headers["Idempotency-Key"]);
  });

  it("refresh rejected (revoked / logged out elsewhere) → session cleared and onSessionExpired fired", async () => {
    await api.setTokens({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });
    const expired = jest.fn();
    api.onSessionExpired = expired;
    mockFetch((c) => (c.path === "/auth/refresh" ? { status: 401, body: { error: "Session revoked" } } : { status: 401, body: {} }));
    await expect(api.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalled();
    expect(api.hasSession).toBe(false);
    api.onSessionExpired = null;
  });

  it("refresh fails offline → session kept (works again once online)", async () => {
    await api.setTokens({ accessToken: "old", refreshToken: "r1", expiresIn: 1 }); // about to expire → proactive refresh
    mockFetch(() => "network");
    await expect(api.get("/x")).rejects.toMatchObject({ status: 0 });
    expect(api.hasSession).toBe(true);
  });

  it("suspended business → onSuspended with the server message", async () => {
    await api.setTokens({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
    const suspended = jest.fn();
    api.onSuspended = suspended;
    mockFetch(() => ({ status: 403, body: { error: "This business account is suspended" } }));
    await expect(api.get("/x")).rejects.toMatchObject({ isSuspended: true });
    expect(suspended).toHaveBeenCalledWith("This business account is suspended");
    api.onSuspended = null;
  });
});
