import http from "node:http";
import type { AddressInfo } from "node:net";
import { signHubBody, HUB_SIGNATURE_HEADER } from "./hub";

/**
 * A local stand-in for a partner hub (tests and local development — never real
 * credentials). Speaks the contract in docs/build/channels-hub-contract.md:
 * records every call, can be told to fail the next N calls, and can sign and send
 * webhooks to CANAVO the way a hub would.
 */
export interface FakeHubCall {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: unknown;
}

export async function startFakeHub(opts: { apiKey?: string } = {}) {
  const calls: FakeHubCall[] = [];
  let failures = 0;
  let failStatus = 500;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const apiKey = req.headers["x-api-key"] as string | undefined;
      calls.push({ method: req.method ?? "", path: req.url ?? "", apiKey, body });
      res.setHeader("content-type", "application/json");
      if (opts.apiKey && apiKey !== opts.apiKey) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ message: "Invalid API key" }));
      }
      if (failures > 0) {
        failures--;
        res.statusCode = failStatus;
        return res.end(JSON.stringify({ message: "Hub is having a bad day" }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    calls,
    /** Fail the next `n` calls with `status` */
    failNext(n: number, status = 500) {
      failures = n;
      failStatus = status;
    },
    reset() {
      calls.length = 0;
      failures = 0;
    },
    /** Send a webhook to CANAVO signed with `secret` (or a given signature, to test rejection). */
    async sendWebhook(url: string, body: unknown, secret: string, signature?: string) {
      const raw = JSON.stringify(body);
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [HUB_SIGNATURE_HEADER]: signature ?? signHubBody(raw, secret) }, body: raw });
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, body: parsed as any };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeHub = Awaited<ReturnType<typeof startFakeHub>>;
