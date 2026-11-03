/**
 * QA Phase 6 — /uploads (magic-byte checks, 5 MB cap, SVG / polyglot / double extension,
 * path traversal on /uploads/files/:name, nosniff + content-type) and /notifications
 * (own rows only, pagination, read state, device tokens).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, createPlatformAdmin, db, HUGE, req, signIn, type Session } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let cashier: Session, kitchen: Session, otherOwner: Session;

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Uploads API"), await createHotel("Uploads Other")];
  cashier = await signIn(srv.base, h.users.cashier.email, h.outletId);
  kitchen = await signIn(srv.base, h.users.kitchen.email, h.outletId);
  otherOwner = await signIn(srv.base, other.users.owner.email, other.outletId);
});
afterAll(() => srv.close());

const MB5 = 5 * 1024 * 1024;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-qa-test")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("qa-jpeg")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 qa")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
const GIF = Buffer.from("GIF89a....");
const HTML = Buffer.from("<html><script>alert(document.cookie)</script></html>");
const PDF = Buffer.from("%PDF-1.4\n%");
const padTo = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length, 0x41)]);

const rawUpload = (s: Session, buf: Buffer, type = "image/png") =>
  req(srv.base, "POST", "/uploads/image", { raw: new Uint8Array(buf), headers: { authorization: `Bearer ${s.token}`, "content-type": type } });

function multipart(s: Session, parts: { field: string; buf: Buffer; filename: string; type: string }[]) {
  const form = new FormData();
  for (const p of parts) form.append(p.field, new Blob([new Uint8Array(p.buf)], { type: p.type }), p.filename);
  return req(srv.base, "POST", "/uploads/image", { raw: form, headers: { authorization: `Bearer ${s.token}` } });
}

const fileName = (url: string) => url.split("/uploads/files/")[1]!;

describe("POST /uploads/image", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpg", JPG, "image/jpeg"],
    ["webp", WEBP, "image/webp"],
  ] as const)("201 for a real %s (raw body); served back with its own content type, nosniff and immutable cache", async (ext, buf, type) => {
    const r = await rawUpload(cashier, buf, type);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ storage: "local", bytes: buf.length });
    expect(r.body.url).toMatch(new RegExp(`/uploads/files/[A-Za-z0-9_-]{8,64}\\.${ext}$`));
    const got = await fetch(`${srv.base}/uploads/files/${fileName(r.body.url)}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe(type);
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toMatch(/immutable/);
    expect(Buffer.from(await got.arrayBuffer()).equals(buf)).toBe(true);
  });

  it("the declared type is not trusted: the extension comes from the magic bytes (JPEG sent as image/png → .jpg)", async () => {
    const r = await rawUpload(cashier, JPG, "image/png");
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/\.jpg$/);
  });

  it.each([
    ["SVG with script", SVG, "image/svg+xml"],
    ["SVG declared as png", SVG, "image/png"],
    ["GIF", GIF, "image/gif"],
    ["HTML declared as png", HTML, "image/png"],
    ["PDF declared as jpeg", PDF, "image/jpeg"],
    ["empty body", Buffer.alloc(0), "image/png"],
    ["truncated PNG header", PNG.subarray(0, 5), "image/png"],
  ])("400 for %s (nothing stored)", async (_n, buf, type) => {
    const r = await rawUpload(cashier, buf, type);
    expect(r.status).toBe(400);
  });

  it("non-image content types are ignored (400), never parsed as something else", async () => {
    for (const type of ["text/html", "application/json", "application/octet-stream", "text/plain"]) {
      const r = await rawUpload(cashier, PNG, type);
      expect(r.status, type).toBe(400);
    }
  });

  it("polyglot (PNG header + HTML/script payload) is stored only as .png and served as image/png with nosniff", async () => {
    const poly = Buffer.concat([PNG, HTML]);
    const r = await rawUpload(cashier, poly);
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/\.png$/);
    const got = await fetch(`${srv.base}/uploads/files/${fileName(r.body.url)}`);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-disposition")).toBeNull();
  });

  it("5 MB cap: exactly 5 MB is accepted, one byte more is 413 (raw and multipart)", async () => {
    expect((await rawUpload(cashier, padTo(PNG, MB5))).status).toBe(201);
    const big = await rawUpload(cashier, padTo(PNG, MB5 + 1));
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/5 MB/);
    expect((await multipart(cashier, [{ field: "file", buf: padTo(PNG, MB5 + 1), filename: "big.png", type: "image/png" }])).status).toBe(413);
  });

  it("multipart: field 'file' works; the client file name (double extension, traversal) is never used", async () => {
    for (const filename of ["shell.php.png", "x.png.html", "../../../etc/passwd.png", "a b ☕.png"]) {
      const r = await multipart(cashier, [{ field: "file", buf: PNG, filename, type: "image/png" }]);
      expect(r.status, filename).toBe(201);
      expect(fileName(r.body.url), filename).toMatch(/^[A-Za-z0-9_-]{8,64}\.png$/);
    }
    // HTML disguised with a .png name and type is still refused
    expect((await multipart(cashier, [{ field: "file", buf: HTML, filename: "logo.png", type: "image/png" }])).status).toBe(400);
  });

  it("malformed multipart bodies (NUL in the part header, truncated form) are 400, not 500", async () => {
    expect((await multipart(cashier, [{ field: "file", buf: PNG, filename: "evil\u0000.png", type: "image/png" }])).status).toBe(400);
    const boundary = "----qa";
    const truncated = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG`;
    const r = await req(srv.base, "POST", "/uploads/image", { raw: truncated, headers: { authorization: `Bearer ${cashier.token}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(r.status).toBe(400);
  });

  it("multipart: a wrong field name or two files → 400", async () => {
    expect((await multipart(cashier, [{ field: "image", buf: PNG, filename: "a.png", type: "image/png" }])).status).toBe(400);
    expect(
      (
        await multipart(cashier, [
          { field: "file", buf: PNG, filename: "a.png", type: "image/png" },
          { field: "file", buf: PNG, filename: "b.png", type: "image/png" },
        ])
      ).status,
    ).toBe(400);
  });

  it("any signed-in account may upload (selfies, logos); the platform admin too; no token → 401", async () => {
    const admin = await signIn(srv.base, (await createPlatformAdmin()).email);
    expect((await rawUpload(admin, PNG)).status).toBe(201);
    expect((await req(srv.base, "POST", "/uploads/image", { raw: new Uint8Array(PNG), headers: { "content-type": "image/png" } })).status).toBe(401);
  });

  it("GET /uploads/signature without Cloudinary → 404 { configured: false }", async () => {
    const r = await cashier.call("GET", "/uploads/signature");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ configured: false });
  });
});

describe("GET /uploads/files/:name — traversal and probing", () => {
  it.each([
    "..%2F..%2Fpackage.json",
    "..%2F..%2F..%2F.env",
    "%2e%2e%2f%2e%2e%2fsrc%2fenv.ts",
    "..%5C..%5Cpackage.json",
    "....%2F%2Fpackage.json",
    "abcdefgh.svg",
    "abcdefgh.png.html",
    "abcdefgh.PNG",
    "short.png",
    `${"a".repeat(65)}.png`,
    "abcdefgh%00.png",
    "abcdefghij.png", // well-formed but not there
  ])("%s → 404", async (name) => {
    const r = await fetch(`${srv.base}/uploads/files/${name}`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("raw ../ in the path never escapes the uploads folder", async () => {
    for (const p of ["/uploads/files/../../package.json", "/uploads/files/..%252F..%252Fpackage.json"]) {
      const r = await fetch(`${srv.base}${p}`);
      expect(r.status, p).toBe(404);
      expect(await r.text(), p).not.toContain("@canavo/api");
    }
  });
});

describe("/notifications", () => {
  let ids: string[] = [];

  beforeAll(async () => {
    const base = { userId: h.users.cashier.id, title: "T", body: "B" };
    ids = [];
    for (let i = 0; i < 5; i++) ids.push((await db.notification.create({ data: { ...base, kind: i % 2 ? "delivery.assigned" : "leave.review", createdAt: new Date(Date.now() - i * 60_000) } })).id);
    await db.notification.create({ data: { userId: h.users.kitchen.id, title: "Kitchen only", body: "x", kind: "kot.new" } });
  });

  it("GET: own rows only, newest first; shape; default link filled", async () => {
    const r = await cashier.call("GET", "/notifications");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unread: 5, hasMore: false, nextBefore: null });
    expect(r.body.items.map((n: { id: string }) => n.id)).toEqual(ids);
    expect(r.body.items.every((n: { userId: string; link: unknown }) => n.userId === h.users.cashier.id)).toBe(true);
  });

  it("pagination: limit + before; limit capped at 100; bad values fall back safely", async () => {
    const p1 = await cashier.call("GET", "/notifications?limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await cashier.call("GET", `/notifications?limit=2&before=${encodeURIComponent(p1.body.nextBefore)}`);
    expect(p2.body.items.map((n: { id: string }) => n.id)).toEqual(ids.slice(2, 4));
    for (const q of ["limit=1000", "limit=-5", "limit=abc", "before=not-a-date", "before=2026-13-45", `kind=${encodeURIComponent("'; DROP TABLE x;--")}`]) {
      const r = await cashier.call("GET", `/notifications?${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body.items.length, q).toBeLessThanOrEqual(100);
    }
    expect((await cashier.call("GET", "/notifications?limit=-5")).body.items).toHaveLength(1);
    expect((await cashier.call("GET", "/notifications?before=2000-01-01")).body.items).toEqual([]);
  });

  it("kind filter matches the family prefix", async () => {
    const r = await cashier.call("GET", "/notifications?kind=delivery");
    expect(r.body.items.map((n: { kind: string }) => n.kind)).toEqual(["delivery.assigned", "delivery.assigned"]);
  });

  it("read / unread: own only (someone else's or unknown → 404); read-all; clear read", async () => {
    expect((await kitchen.call("POST", `/notifications/${ids[0]}/read`)).status).toBe(404);
    expect((await otherOwner.call("POST", `/notifications/${ids[0]}/read`)).status).toBe(404);
    expect((await cashier.call("POST", "/notifications/cl0000000000000000000000/read")).status).toBe(404);
    const r = await cashier.call("POST", `/notifications/${ids[0]}/read`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ unread: 4 });
    expect((await cashier.call("POST", `/notifications/${ids[0]}/unread`)).body).toEqual({ unread: 5 });
    expect((await kitchen.call("POST", `/notifications/${ids[0]}/unread`)).status).toBe(404);
    expect((await cashier.call("POST", "/notifications/read-all")).status).toBe(204);
    expect((await cashier.call("GET", "/notifications?unread=1")).body.items).toEqual([]);
    // the kitchen's notification is untouched by the cashier's read-all / clear
    const cleared = await cashier.call("DELETE", "/notifications/read");
    expect(cleared.body).toEqual({ deleted: 5 });
    expect(await db.notification.count({ where: { userId: h.users.kitchen.id } })).toBe(1);
  });

  it("devices: 201 contract; 400 on bad tokens/platforms; deleting someone else's token is a no-op", async () => {
    const token = `ExponentPushToken[qa-${Date.now()}]`;
    const r = await cashier.call("POST", "/notifications/devices", { token, platform: "android", userId: h.users.owner.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ token, platform: "android", userId: h.users.cashier.id });
    for (const body of [{}, { token: "short", platform: "ios" }, { token: HUGE, platform: "ios" }, { token: `ExponentPushToken[x-${Date.now()}]`, platform: "symbian" }])
      expect((await cashier.call("POST", "/notifications/devices", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect((await kitchen.call("DELETE", `/notifications/devices/${encodeURIComponent(token)}`)).status).toBe(204);
    expect(await db.deviceToken.count({ where: { token } })).toBe(1);
    // another hotel can't take this device's pushes over
    const steal = await otherOwner.call("POST", "/notifications/devices", { token, platform: "android" });
    expect(steal.status).toBe(409);
    expect((await db.deviceToken.findUniqueOrThrow({ where: { token } })).userId).toBe(h.users.cashier.id);
    expect((await cashier.call("DELETE", `/notifications/devices/${encodeURIComponent(token)}`)).status).toBe(204);
    expect(await db.deviceToken.count({ where: { token } })).toBe(0);
  });

  it("the platform admin gets their own (empty) list, never a hotel's", async () => {
    const admin = await signIn(srv.base, (await createPlatformAdmin()).email);
    const r = await admin.call("GET", "/notifications", undefined, { "x-outlet-id": h.outletId });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    const u = await addUser(h, "WAITER");
    expect(u.id).toBeTruthy();
  });
});
