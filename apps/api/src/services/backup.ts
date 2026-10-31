/**
 * Backup / restore / data export for every table in the Prisma schema.
 *
 * Backup format: gzipped NDJSON —
 *   {"type":"header","format":"canavo-backup","version":1,"migrations":[…],"models":[…]}
 *   {"m":"Outlet","r":{…row…}}          (tables in FK-safe order; self-referencing rows parent-first)
 *   {"type":"end","counts":{…}}
 * Rows are read table by table inside one REPEATABLE READ transaction (consistent snapshot)
 * and streamed to disk, so memory stays bounded by the page size.
 */
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Response } from "express";
import archiver from "archiver";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { badRequest, conflict, notFound } from "../lib/http";
import { storageDir } from "./storage";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

const PAGE = 1000;
const BACKUP_RE = /^canavo-backup-(auto|manual)-\d{8}-\d{6}\.ndjson\.gz$/;

export const backupsDir = () => storageDir("backups");

// ---------- Schema introspection ----------

const models = (): readonly DmmfModel[] => Prisma.dmmf.datamodel.models;
const delegateName = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
const tableName = (m: DmmfModel) => m.dbName ?? m.name;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (tx: Tx | typeof prisma, model: string): any => (tx as unknown as Record<string, unknown>)[delegateName(model)];

function pkFields(m: DmmfModel): string[] {
  if (m.primaryKey?.fields?.length) return [...m.primaryKey.fields];
  return m.fields.filter((f) => f.isId).map((f) => f.name);
}

/** FK dependencies (models this model references), excluding self references. */
function deps(m: DmmfModel): string[] {
  return m.fields
    .filter((f) => f.kind === "object" && (f.relationFromFields?.length ?? 0) > 0 && f.type !== m.name)
    .map((f) => f.type);
}

/** Models in FK-safe insert order (Kahn's algorithm; ties broken by schema order). */
export function insertOrder(all: readonly DmmfModel[] = models()): DmmfModel[] {
  const byName = new Map(all.map((m) => [m.name, m]));
  const remaining = new Map(all.map((m) => [m.name, new Set(deps(m).filter((d) => byName.has(d)))]));
  const out: DmmfModel[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, d]) => d.size === 0).map(([n]) => n);
    if (!ready.length) throw new Error(`Cyclic foreign keys between: ${[...remaining.keys()].join(", ")}`);
    for (const n of ready) {
      out.push(byName.get(n)!);
      remaining.delete(n);
      for (const d of remaining.values()) d.delete(n);
    }
  }
  return out;
}

/** Self-referencing FK columns, e.g. MenuCategory.parentId. */
function selfFks(m: DmmfModel): { from: string; to: string }[] {
  return m.fields
    .filter((f) => f.kind === "object" && f.type === m.name && (f.relationFromFields?.length ?? 0) === 1)
    .map((f) => ({ from: f.relationFromFields![0], to: f.relationToFields![0] }));
}

/** Parent-first ordering of rows for self-referencing tables. */
export function parentFirst(rows: Row[], fks: { from: string; to: string }[]): Row[] {
  if (!fks.length) return rows;
  const out: Row[] = [];
  const placed = new Set<string>();
  let pending = rows;
  while (pending.length) {
    const next: Row[] = [];
    for (const r of pending) {
      const ok = fks.every((fk) => r[fk.from] == null || placed.has(`${fk.to}:${String(r[fk.from])}`) || r[fk.from] === r[fk.to]);
      if (ok) {
        out.push(r);
        fks.forEach((fk) => placed.add(`${fk.to}:${String(r[fk.to])}`));
      } else next.push(r);
    }
    if (next.length === pending.length) return [...out, ...next]; // dangling parents — let the DB complain
    pending = next;
  }
  return out;
}

async function appliedMigrations(tx: Tx | typeof prisma = prisma): Promise<string[]> {
  const rows = await tx.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
  return rows.map((r) => r.migration_name);
}

/** Page through a table ordered by primary key, calling `onRows` per page. */
async function eachPage(tx: Tx, m: DmmfModel, onRows: (rows: Row[]) => Promise<void> | void, where?: Row) {
  const orderBy = pkFields(m).map((f) => ({ [f]: "asc" }));
  for (let skip = 0; ; skip += PAGE) {
    const rows: Row[] = await delegate(tx, m.name).findMany({ where, orderBy, skip, take: PAGE });
    if (rows.length) await onRows(rows);
    if (rows.length < PAGE) break;
  }
}

// ---------- Backup ----------

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function createBackup(kind: "auto" | "manual" = "manual") {
  const file = `canavo-backup-${kind}-${stamp()}.ndjson.gz`;
  const full = path.join(backupsDir(), file);
  const gzip = createGzip();
  const out = createWriteStream(full);
  gzip.pipe(out);
  const write = async (obj: unknown) => {
    if (!gzip.write(JSON.stringify(obj) + "\n")) await once(gzip, "drain");
  };
  const counts: Record<string, number> = {};
  try {
    await prisma.$transaction(
      async (tx) => {
        const order = insertOrder();
        await write({
          type: "header", format: "canavo-backup", version: 1, createdAt: new Date().toISOString(),
          migrations: await appliedMigrations(tx), models: order.map((m) => m.name),
        });
        for (const m of order) {
          counts[m.name] = 0;
          const fks = selfFks(m);
          if (fks.length) {
            const all: Row[] = [];
            await eachPage(tx, m, (rows) => void all.push(...rows));
            for (const r of parentFirst(all, fks)) await write({ m: m.name, r });
            counts[m.name] = all.length;
          } else {
            await eachPage(tx, m, async (rows) => {
              for (const r of rows) await write({ m: m.name, r });
              counts[m.name] += rows.length;
            });
          }
        }
        await write({ type: "end", counts });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60_000, maxWait: 10_000 },
    );
    gzip.end();
    await once(out, "finish");
  } catch (e) {
    gzip.destroy();
    out.destroy();
    await unlink(full).catch(() => undefined);
    throw e;
  }
  const { size } = await stat(full);
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.info(`[backup] wrote ${file} (${rows} rows, ${size} bytes)`);
  return { file, size, rows, counts };
}

export async function listBackups() {
  const dir = backupsDir();
  const files = (await readdir(dir)).filter((f) => BACKUP_RE.test(f));
  const out = await Promise.all(
    files.map(async (file) => {
      const s = await stat(path.join(dir, file));
      return { file, size: s.size, createdAt: s.mtime, kind: file.includes("-auto-") ? "auto" : "manual" };
    }),
  );
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.file.localeCompare(a.file));
}

/** Resolve a backup file name to a path inside the backups dir (rejects traversal / unknown names). */
export function backupPath(file: string): string {
  if (!BACKUP_RE.test(file) || path.basename(file) !== file) throw badRequest("Invalid backup file name");
  return path.join(backupsDir(), file);
}

export async function assertBackupExists(file: string) {
  const p = backupPath(file);
  try {
    await stat(p);
  } catch {
    throw notFound("Backup");
  }
  return p;
}

/** Keep the newest `keep` automatic backups. */
export async function pruneBackups(keep = env.BACKUP_RETENTION) {
  const autos = (await listBackups()).filter((b) => b.kind === "auto").sort((a, b) => b.file.localeCompare(a.file));
  for (const b of autos.slice(keep)) {
    await unlink(path.join(backupsDir(), b.file));
    console.info(`[backup] pruned ${b.file}`);
  }
}

// ---------- Restore ----------

/** Convert JSON-decoded values back into what Prisma createMany expects. */
function reviveRow(m: DmmfModel, r: Row): Row {
  const out: Row = {};
  for (const f of m.fields) {
    if (f.kind === "object" || !(f.name in r)) continue;
    const v = r[f.name];
    if (f.type === "Json" && v === null) out[f.name] = Prisma.DbNull;
    else out[f.name] = v;
  }
  return out;
}

export async function restoreBackup(file: string) {
  const full = await assertBackupExists(file);
  const byName = new Map(models().map((m) => [m.name, m]));
  const lines = createInterface({ input: createReadStream(full).pipe(createGunzip()), crlfDelay: Infinity });
  const iter = lines[Symbol.asyncIterator]();

  const first = await iter.next();
  if (first.done) throw badRequest("Backup file is empty");
  const header = JSON.parse(first.value) as { type: string; format: string; version: number; migrations: string[]; createdAt: string };
  if (header.type !== "header" || header.format !== "canavo-backup" || header.version !== 1) throw badRequest("Not a CANAVO backup file");
  const current = await appliedMigrations();
  if (JSON.stringify(header.migrations) !== JSON.stringify(current)) {
    lines.close();
    throw conflict(
      `Backup schema does not match this database. Backup migrations: [${header.migrations.join(", ")}]; database: [${current.join(", ")}]`,
    );
  }

  const counts: Record<string, number> = {};
  await prisma.$transaction(
    async (tx) => {
      const tables = models().map((m) => `"${tableName(m)}"`).join(", ");
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      let model: DmmfModel | undefined;
      let batch: Row[] = [];
      let ended = false;
      const flush = async () => {
        if (!model || !batch.length) return;
        await delegate(tx, model.name).createMany({ data: batch });
        counts[model.name] = (counts[model.name] ?? 0) + batch.length;
        batch = [];
      };
      for (let n = await iter.next(); !n.done; n = await iter.next()) {
        if (!n.value.trim()) continue;
        const rec = JSON.parse(n.value) as { m?: string; r?: Row; type?: string; counts?: Record<string, number> };
        if (rec.type === "end") {
          await flush();
          for (const [name, c] of Object.entries(rec.counts ?? {})) {
            if ((counts[name] ?? 0) !== c) throw new Error(`Row count mismatch for ${name}: file says ${c}, restored ${counts[name] ?? 0}`);
          }
          ended = true;
          break;
        }
        const m = rec.m ? byName.get(rec.m) : undefined;
        if (!m || !rec.r) throw badRequest(`Unknown table in backup: ${rec.m}`);
        if (m !== model) {
          await flush();
          model = m;
        }
        batch.push(reviveRow(m, rec.r));
        if (batch.length >= 500) await flush();
      }
      if (!ended) throw badRequest("Backup file is truncated (no end marker) — nothing was restored");
    },
    { timeout: 15 * 60_000, maxWait: 10_000 },
  );
  lines.close();
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.info(`[backup] restored ${file} (${rows} rows)`);
  return { file, backupCreatedAt: header.createdAt, rows, counts };
}

/** Current row count of every table (used to verify a restore). */
export async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of models()) out[m.name] = await delegate(prisma, m.name).count();
  return out;
}

// ---------- Data export (redacted) ----------

/** Secrets never leave the server in a data export (backups are full-fidelity). */
const EXCLUDED_MODELS = new Set(["RefreshToken", "OtpCode"]);
const REDACTED_FIELDS = new Set(["passwordHash", "pinHash", "tokenHash", "codeHash", "aadhaarEnc"]);

function redact(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (!REDACTED_FIELDS.has(k)) out[k] = v;
  return out;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Where-clause limiting a model to one business: its own businessId / outletId,
 * or (up to 3 hops) through a required parent relation that has one.
 * null = the model can't be tied to a business (platform-wide data) → not exported.
 */
function businessWhere(m: DmmfModel, businessId: string, outletIds: string[], depth = 0): Row | null {
  const names = new Set(m.fields.map((f) => f.name));
  if (m.name === "Business") return { id: businessId };
  if (names.has("businessId")) return { businessId };
  if (names.has("outletId")) return { outletId: { in: outletIds } };
  if (m.name === "Setting") return { scope: { in: [businessId, ...outletIds] } };
  if (depth >= 3) return null;
  const byName = new Map(models().map((x) => [x.name, x]));
  for (const f of m.fields) {
    if (f.kind !== "object" || f.isList || !f.relationFromFields?.length || !f.isRequired) continue;
    const parent = byName.get(f.type);
    const inner = parent && businessWhere(parent, businessId, outletIds, depth + 1);
    if (inner) return { [f.name]: inner };
  }
  return null;
}

export async function streamExport(res: Response, format: "json" | "csv-zip", businessId?: string) {
  const outletIds = businessId ? (await prisma.outlet.findMany({ where: { businessId }, select: { id: true } })).map((o) => o.id) : [];
  const scoped = insertOrder()
    .filter((m) => !EXCLUDED_MODELS.has(m.name))
    .map((m) => ({ m, where: businessId ? businessWhere(m, businessId, outletIds) : undefined }))
    .filter((x) => x.where !== null);
  const order = scoped.map((x) => x.m);
  const whereOf = new Map(scoped.map((x) => [x.m.name, x.where ?? undefined]));
  const ts = stamp();
  const tx = prisma as unknown as Tx;
  if (format === "json") {
    res.setHeader("content-disposition", `attachment; filename="canavo-export-${ts}.json"`);
    res.type("application/json");
    const w = async (s: string) => {
      if (!res.write(s)) await once(res, "drain");
    };
    await w(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"tables":{`);
    for (const [i, m] of order.entries()) {
      await w(`${i ? "," : ""}${JSON.stringify(m.name)}:[`);
      let firstRow = true;
      await eachPage(
        tx,
        m,
        async (rows) => {
          for (const r of rows) {
            await w((firstRow ? "" : ",") + JSON.stringify(redact(r)));
            firstRow = false;
          }
        },
        whereOf.get(m.name),
      );
      await w("]");
    }
    await w("}}");
    res.end();
    return;
  }
  res.setHeader("content-disposition", `attachment; filename="canavo-export-${ts}.zip"`);
  res.type("application/zip");
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.on("warning", (e) => console.warn("[export]", e));
  zip.pipe(res);
  for (const m of order) {
    const cols = m.fields.filter((f) => f.kind !== "object" && !REDACTED_FIELDS.has(f.name)).map((f) => f.name);
    const parts: string[] = [cols.join(",")];
    await eachPage(
      tx,
      m,
      (rows) => {
        for (const r of rows) parts.push(cols.map((c) => csvCell(r[c])).join(","));
      },
      whereOf.get(m.name),
    );
    zip.append(parts.join("\r\n") + "\r\n", { name: `${m.name}.csv` });
  }
  await zip.finalize();
}
