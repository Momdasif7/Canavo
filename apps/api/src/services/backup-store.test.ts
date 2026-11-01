/**
 * Contract tests for off-site backup stores. The S3 adapter (real AWS SDK) runs against a
 * minimal S3 wire-protocol stand-in (path-style PutObject / GetObject / ListObjectsV2);
 * signatures are not verified by the stand-in. Real-provider checks: manual runbook.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryStore, S3Store, type OffsiteStore } from "./backup-store";

const objects = new Map<string, Buffer>();
let endpoint = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const [, bucket, ...rest] = url.pathname.split("/");
  const key = decodeURIComponent(rest.join("/"));
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "PUT" && key) {
      objects.set(`${bucket}/${key}`, Buffer.concat(chunks));
      res.setHeader("ETag", '"etag"');
      return res.end();
    }
    if (req.method === "GET" && key) {
      const b = objects.get(`${bucket}/${key}`);
      if (!b) return (res.statusCode = 404), res.end("<Error><Code>NoSuchKey</Code></Error>");
      res.setHeader("content-length", b.length);
      return res.end(b);
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...objects.entries()].filter(([k]) => k.startsWith(`${bucket}/${prefix}`));
      res.setHeader("content-type", "application/xml");
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${items.length}</KeyCount><IsTruncated>false</IsTruncated>` +
          items.map(([k, v]) => `<Contents><Key>${k.slice(bucket!.length + 1)}</Key><Size>${v.length}</Size><LastModified>2026-11-01T00:00:00.000Z</LastModified></Contents>`).join("") +
          "</ListBucketResult>",
      );
    }
    res.statusCode = 400;
    res.end();
  });
});

let tmp = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = await mkdtemp(path.join(os.tmpdir(), "canavo-store-"));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const contract = (name: string, make: () => OffsiteStore) =>
  describe(`${name} store contract`, () => {
    it("put → list → get round-trips the exact bytes", async () => {
      const store = make();
      const file = path.join(tmp, `canavo-backup-auto-20261101-020000-${name}.ndjson.gz`);
      const bytes = Buffer.from(`backup ${name} ${"x".repeat(5000)}`);
      await writeFile(file, bytes);
      await store.put(path.basename(file), file);
      const listed = await store.list();
      const hit = listed.find((o) => o.key === path.basename(file));
      expect(hit?.size).toBe(bytes.length);
      const back = path.join(tmp, `restored-${name}`);
      await store.get(path.basename(file), back);
      expect((await readFile(back)).equals(bytes)).toBe(true);
    });
  });

contract("dir", () => new DirectoryStore(path.join(tmp, "offsite")));
contract("s3", () => new S3Store({ bucket: "canavo", region: "auto", prefix: "prod/", endpoint, accessKeyId: "test", secretAccessKey: "test" }));

describe("S3 location", () => {
  it("reports bucket and prefix (no credentials)", () => {
    const s = new S3Store({ bucket: "canavo", region: "ap-south-1", prefix: "prod/", accessKeyId: "AKIA", secretAccessKey: "secret" });
    expect(s.location).toBe("s3://canavo/prod/");
    expect(s.location).not.toContain("secret");
  });
});

describe("backup row serialisation", () => {
  it("BigInt columns survive a backup round-trip (outbox seq)", async () => {
    const { bigintReplacer, bigintReviver } = await import("./backup");
    const row = { seq: 9007199254740993n, name: "kot:new", payload: { a: 1 } };
    const back = JSON.parse(JSON.stringify(row, bigintReplacer), bigintReviver);
    expect(back).toEqual(row);
    expect(typeof back.seq).toBe("bigint");
  });
});
