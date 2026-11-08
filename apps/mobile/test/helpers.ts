/** Test helpers: a fake CANAVO API behind global.fetch. */

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (call: FakeCall) => { status: number; body?: unknown } | "network" | Promise<{ status: number; body?: unknown } | "network">;

/**
 * Install a fetch mock. `handler` returns { status, body } or "network" (connection failure).
 * Returns the recorded calls.
 */
export function mockFetch(handler: Handler): FakeCall[] {
  const calls: FakeCall[] = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const call: FakeCall = {
      method: init.method ?? "GET",
      path: u.pathname,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const r = await handler(call);
    if (r === "network") throw new TypeError("Network request failed");
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : {}),
    };
  });
  return calls;
}

export const tokens = { accessToken: "acc-1", refreshToken: "ref-1", expiresIn: 3600 };
