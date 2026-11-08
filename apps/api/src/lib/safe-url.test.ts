import { describe, expect, it } from "vitest";
import { hubErrorMessage, hubFetch, hubUrlError } from "./safe-url";

describe("hub URL rules (QA BUG-048)", () => {
  it("production: https to a public host only", () => {
    expect(hubUrlError("https://hub.urbanpiper.com/api", true)).toBeNull();
    for (const bad of ["http://hub.example.com", "https://127.0.0.1", "https://10.1.2.3", "https://192.168.0.5", "https://localhost:8080", "https://[::1]/", "https://169.254.169.254", "https://db.internal", "https://intranet"]) {
      expect(hubUrlError(bad, true), bad).not.toBeNull();
    }
  });

  it("development: loopback / private allowed (local fake hub), metadata and credentials never", () => {
    expect(hubUrlError("http://127.0.0.1:4010", false)).toBeNull();
    expect(hubUrlError("http://10.0.0.7", false)).toBeNull();
    for (const bad of ["http://169.254.169.254/latest/meta-data", "http://[::ffff:169.254.169.254]/", "http://[fe80::1]/", "http://metadata.google.internal", "https://u:p@hub.example.com", "file:///etc/passwd", "not a url"]) {
      expect(hubUrlError(bad, false), bad).not.toBeNull();
    }
  });

  it("refuses a public-looking name that resolves to an internal address (DNS rebinding)", async () => {
    const to = (ip: string) => async () => [ip];
    await expect(hubFetch("https://hub.example.com/v1", {}, true, to("10.0.0.1"))).rejects.toThrow(/internal network/);
    await expect(hubFetch("https://hub.example.com/v1", {}, false, to("169.254.169.254"))).rejects.toThrow(/internal network/);
    await expect(hubFetch("https://hub.example.com/v1", {}, true, async () => ["203.0.113.9", "127.0.0.1"])).rejects.toThrow(/internal network/);
  });

  it("never shows a hub's raw error body — only a short JSON message", async () => {
    expect(await hubErrorMessage(new Response("root:x:0:0:root:/root:/bin/bash\nsecret-config=1"))).toBe("");
    expect(await hubErrorMessage(new Response(JSON.stringify({ message: "Invalid API key" })))).toBe("Invalid API key");
    expect((await hubErrorMessage(new Response(JSON.stringify({ error: "x".repeat(500) })))).length).toBe(120);
  });
});

describe("hub calls connect to the address that was checked (QA Phase 8, sec1-6: DNS rebinding)", () => {
  it("uses the resolved, checked address for the connection — the name is not looked up again", async () => {
    const http = await import("node:http");
    const seen: { host?: string } = {};
    const server = http.createServer((req, res) => {
      seen.host = req.headers.host;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    let lookups = 0;
    try {
      // "hub.rebind.invalid" can't be resolved by the system: only the pinned address can reach the server.
      const res = await hubFetch(`http://hub.rebind.invalid:${port}/v1/ping`, { method: "POST", headers: { "x-api-key": "k" }, body: "{}" }, false, async () => {
        lookups++;
        return ["127.0.0.1"];
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(lookups).toBe(1);
      expect(seen.host).toBe(`hub.rebind.invalid:${port}`);
    } finally {
      server.close();
    }
  });

  it("a redirect is still refused", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/");
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      await expect(hubFetch(`http://127.0.0.1:${port}/v1`, {}, false)).rejects.toThrow(/redirect/);
    } finally {
      server.close();
    }
  });
});
