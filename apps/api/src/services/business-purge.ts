/**
 * P2 gap 8b (docs/qa/known-gaps.md): delete an archived business once its statutory retention date has passed.
 *
 *  1. Final export: from 30 days before `deleteAfter` (the retention job, or a super admin by hand) the business's
 *     data is written to storage/exports as a CSV zip and every owner is emailed a one-time-token download link
 *     (the super admin never gets the file or the link — platform privacy rule).
 *  2. A super admin approves the purge per business, typing its name; it is refused before `deleteAfter`, before the
 *     export was offered 30 days earlier, or for a business that isn't archived. A dry-run report (row counts per
 *     table) comes first.
 *  3. The purge (RLS bypassed) deletes the uploaded files the rows point at, then every business-scoped table in FK
 *     order (children first, in batches), then the Business row and the export file. It leaves only a
 *     BusinessTombstone (id, name hash, dates, row counts) and the platform audit entry.
 *  Idempotent: the tombstone is written first; a purge that stopped half way is resumed by the retention job.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { platformPrisma as db } from "../db";
import { env } from "../env";
import { conflict, notFound } from "../lib/http";
import { businessWhere, insertOrder, pkFields, selfFks, writeExport, type DmmfModel, type Tx } from "./backup";
import { sendMail } from "./mailer";
import { storageDir } from "./storage";

const DAY = 86_400_000;
/** The owner's final export is offered this long before the data may be deleted. */
export const FINAL_EXPORT_NOTICE_DAYS = 30;
const BATCH = 500;
const UPLOAD_RE = /\/uploads\/files\/([a-zA-Z0-9_-]{8,64}\.(?:jpg|png|webp))/g;
const CLOUDINARY_RE = /res\.cloudinary\.com\/[^/"]+\/image\/upload\/(?:[^/"]+\/)*?(?:v\d+\/)?([^"\s]+?)\.(?:jpg|jpeg|png|webp)/g;

const exportsDir = () => storageDir("exports");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const nameHash = (name: string) => sha256(name.trim().toLowerCase());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (model: string): any => (db as unknown as Record<string, unknown>)[model.charAt(0).toLowerCase() + model.slice(1)];

/** Business-scoped models (children first) with their where-clause; platform tables are never touched. */
async function scopedModels(businessId: string) {
  const outletIds = (await db.outlet.findMany({ where: { businessId }, select: { id: true } })).map((o) => o.id);
  return insertOrder()
    .reverse()
    .filter((m) => m.name !== "Business")
    .map((m) => ({ m, where: businessWhere(m, businessId, outletIds) as Record<string, unknown> | null }))
    .filter((x): x is { m: DmmfModel; where: Record<string, unknown> } => x.where !== null);
}

// ---------------------------------------------------------------------------
// Final export
// ---------------------------------------------------------------------------

/**
 * Write the business's final export and email every owner a download link. Re-offering issues a new link
 * (the old one stops working) and keeps the first offer date, which starts the 30-day notice.
 */
export async function offerFinalExport(businessId: string, now = new Date()): Promise<{ sentTo: number; token: string; finalExportAt: Date }> {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { name: true, status: true, deleteAfter: true, finalExportAt: true, finalExportFile: true } });
  if (!b) throw notFound("Business");
  if (b.status !== "ARCHIVED") throw conflict("Only an archived business gets a final export");
  let file = b.finalExportFile;
  if (!file || !(await exists(path.join(exportsDir(), file)))) {
    file = `final-${businessId}-${randomBytes(8).toString("hex")}.zip`;
    const out = createWriteStream(path.join(exportsDir(), file));
    const closed = once(out, "close");
    await writeExport(out, "csv-zip", businessId, db as unknown as Tx);
    await closed;
  }
  const token = randomBytes(32).toString("base64url");
  const finalExportAt = b.finalExportAt ?? now;
  await db.business.update({ where: { id: businessId }, data: { finalExportAt, finalExportFile: file, finalExportTokenHash: sha256(token) } });
  const owners = await db.user.findMany({ where: { businessId, role: "BUSINESS_OWNER", email: { not: null } }, select: { email: true, name: true } });
  const link = `${env.PUBLIC_API_URL.replace(/\/$/, "")}/public/business-export/${token}`;
  const until = b.deleteAfter ? b.deleteAfter.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" }) : "the deletion date";
  for (const o of owners) {
    await sendMail(
      {
        to: o.email!,
        subject: `${b.name}: download your data before it is deleted`,
        html:
          `<p>Hello ${escapeHtml(o.name ?? "")},</p><p>${escapeHtml(b.name)} was archived on CANAVO and its statutory retention period ends on <b>${until}</b>. ` +
          `After that date all of its data (bills, menu, customers, staff and uploaded images) will be permanently deleted.</p>` +
          `<p><a href="${link}">Download the final export (CSV files in a zip)</a>. Keep it for your own records; the link works until the data is deleted.</p>`,
      },
      { scope: "platform" },
    );
  }
  return { sentTo: owners.length, token, finalExportAt };
}

/** The export file behind a download token (only while the business is archived and not yet deleted). */
export async function finalExportByToken(token: string): Promise<{ file: string; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const b = await db.business.findFirst({ where: { finalExportTokenHash: sha256(token), status: "ARCHIVED" }, select: { name: true, finalExportFile: true } });
  if (!b?.finalExportFile) return null;
  const file = path.join(exportsDir(), b.finalExportFile);
  return (await exists(file)) ? { file, name: b.name } : null;
}

// ---------------------------------------------------------------------------
// Dry run + approval
// ---------------------------------------------------------------------------

export interface PurgeStatus {
  deleteAfter: Date | null;
  finalExportAt: Date | null;
  /** First day the purge can be approved (later of deleteAfter and export offer + 30 days) */
  purgeFrom: Date | null;
  canPurge: boolean;
  blockers: string[];
}

export function purgeStatus(b: { status: string; deleteAfter: Date | null; finalExportAt: Date | null }, now = new Date()): PurgeStatus {
  const blockers: string[] = [];
  if (b.status !== "ARCHIVED") blockers.push("Only an archived business can be deleted");
  if (!b.deleteAfter || now < b.deleteAfter) {
    blockers.push(`The statutory retention period runs until ${b.deleteAfter ? b.deleteAfter.toISOString().slice(0, 10) : "(not archived)"}`);
  }
  const noticeEnds = b.finalExportAt ? new Date(b.finalExportAt.getTime() + FINAL_EXPORT_NOTICE_DAYS * DAY) : null;
  if (!noticeEnds) blockers.push("The owner's final export hasn't been offered yet");
  else if (now < noticeEnds) blockers.push(`The owner has until ${noticeEnds.toISOString().slice(0, 10)} to download the final export (${FINAL_EXPORT_NOTICE_DAYS} days' notice)`);
  const purgeFrom = b.deleteAfter && noticeEnds ? new Date(Math.max(b.deleteAfter.getTime(), noticeEnds.getTime())) : null;
  return { deleteAfter: b.deleteAfter, finalExportAt: b.finalExportAt, purgeFrom, canPurge: blockers.length === 0, blockers };
}

/** Dry run: what the purge would delete (row counts per table; no hotel data). */
export async function purgePreview(businessId: string, now = new Date()) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { status: true, deleteAfter: true, finalExportAt: true } });
  if (!b) throw notFound("Business");
  const tables: Record<string, number> = {};
  for (const { m, where } of await scopedModels(businessId)) {
    const n: number = await delegate(m.name).count({ where });
    if (n) tables[m.name] = n;
  }
  return { ...purgeStatus(b, now), tables, totalRows: Object.values(tables).reduce((a, c) => a + c, 0) + 1 };
}

/** Approve and run the purge (super admin). Throws 409 with the reason when it isn't allowed yet. */
export async function approvePurge(businessId: string, approvedById: string | null, now = new Date()) {
  const done = await db.businessTombstone.findUnique({ where: { id: businessId } });
  if (done) return done.completedAt ? done : runPurge(businessId);
  const b = await db.business.findUnique({ where: { id: businessId }, select: { name: true, createdAt: true, status: true, archivedAt: true, deleteAfter: true, finalExportAt: true } });
  if (!b) throw notFound("Business");
  const st = purgeStatus(b, now);
  if (!st.canPurge) throw conflict(st.blockers.join(". "));
  await db.businessTombstone.create({
    data: {
      id: businessId,
      nameHash: nameHash(b.name),
      businessCreatedAt: b.createdAt,
      archivedAt: b.archivedAt,
      deleteAfter: b.deleteAfter!,
      finalExportAt: b.finalExportAt,
      approvedById,
      approvedAt: now,
    },
  });
  return runPurge(businessId);
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Uploaded images referenced anywhere in these rows. */
function fileRefs(rows: unknown[]) {
  const text = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const local = new Set<string>();
  const cloud = new Set<string>();
  for (const m of text.matchAll(UPLOAD_RE)) local.add(m[1]);
  for (const m of text.matchAll(CLOUDINARY_RE)) cloud.add(m[1]);
  return { local, cloud };
}

async function destroyCloudinary(publicId: string): Promise<boolean> {
  if (!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("sha1").update(`public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`).digest("hex");
  const form = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: env.CLOUDINARY_API_KEY, signature });
  try {
    const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: "POST", body: form });
    const j = (await r.json()) as { result?: string };
    return r.ok && (j.result === "ok" || j.result === "not found");
  } catch {
    return false;
  }
}

/** Delete the business's files and rows; safe to call again after a crash (finishes what is left). */
export async function runPurge(businessId: string) {
  const tomb = await db.businessTombstone.findUnique({ where: { id: businessId } });
  if (!tomb) throw conflict("This purge was not approved");
  if (tomb.completedAt) return tomb;
  const counts: Record<string, number> = { ...((tomb.rowCounts as Record<string, number>) ?? {}) };
  let filesDeleted = 0;
  let filesFailed = 0;
  const business = await db.business.findUnique({ where: { id: businessId }, select: { status: true, finalExportFile: true } });
  if (business && business.status !== "ARCHIVED") throw conflict("Only an archived business can be deleted");

  if (business) {
    const models = await scopedModels(businessId);
    // 1. Files first (the rows say which files are this business's); a re-run finds the rest.
    const local = new Set<string>();
    const cloud = new Set<string>();
    const scan = (rows: unknown[]) => {
      const r = fileRefs(rows);
      r.local.forEach((f) => local.add(f));
      r.cloud.forEach((f) => cloud.add(f));
    };
    scan([await db.business.findUnique({ where: { id: businessId } })]);
    for (const { m, where } of models) {
      const pk = pkFields(m);
      for (let skip = 0; ; skip += 1000) {
        const rows: Record<string, unknown>[] = await delegate(m.name).findMany({ where, orderBy: pk.map((f) => ({ [f]: "asc" })), skip, take: 1000 });
        scan(rows);
        if (rows.length < 1000) break;
      }
    }
    const uploads = storageDir("uploads");
    for (const f of local) {
      try {
        await unlink(path.join(uploads, f));
        filesDeleted++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") filesFailed++;
      }
    }
    for (const id of cloud) (await destroyCloudinary(id)) ? filesDeleted++ : filesFailed++;

    // 2. Rows, children first, in batches by primary key.
    const users = (await db.user.findMany({ where: { businessId }, select: { id: true } })).map((u) => u.id);
    // Platform audit entries stay (businessId NULL); they must not keep a hotel user alive.
    if (users.length) await db.auditLog.updateMany({ where: { businessId: null, userId: { in: users } }, data: { userId: null } });
    for (const { m, where } of models) {
      for (const fk of selfFks(m)) {
        const f = m.fields.find((x) => x.name === fk.from);
        if (f && !f.isRequired) await delegate(m.name).updateMany({ where, data: { [fk.from]: null } });
      }
      const pk = pkFields(m);
      let n = 0;
      if (pk.length === 1) {
        for (;;) {
          const ids = (await delegate(m.name).findMany({ where, select: { [pk[0]]: true }, take: BATCH })).map((r: Record<string, unknown>) => r[pk[0]]);
          if (!ids.length) break;
          n += (await delegate(m.name).deleteMany({ where: { [pk[0]]: { in: ids } } })).count;
        }
      } else n = (await delegate(m.name).deleteMany({ where })).count;
      if (n) counts[m.name] = (counts[m.name] ?? 0) + n;
    }
    // 3. The business row itself, then its final export.
    await db.business.delete({ where: { id: businessId } });
    counts.Business = 1;
    if (business.finalExportFile) await unlink(path.join(exportsDir(), business.finalExportFile)).catch(() => undefined);
  }
  return db.businessTombstone.update({
    where: { id: businessId },
    data: {
      completedAt: new Date(),
      rowCounts: counts as Prisma.InputJsonValue,
      filesDeleted: { increment: filesDeleted },
      filesFailed: { increment: filesFailed },
    },
  });
}

// ---------------------------------------------------------------------------
// Retention job
// ---------------------------------------------------------------------------

/**
 * Daily platform job (idempotent): offers the final export to businesses entering the 30-day notice window,
 * finishes purges that stopped half way, and lists businesses ready for a super admin's approval. It never
 * deletes a business nobody approved.
 */
export async function runBusinessRetention(now = new Date()) {
  const soon = new Date(now.getTime() + FINAL_EXPORT_NOTICE_DAYS * DAY);
  const offered: string[] = [];
  for (const b of await db.business.findMany({ where: { status: "ARCHIVED", finalExportAt: null, deleteAfter: { lte: soon } }, select: { id: true } })) {
    try {
      await offerFinalExport(b.id, now);
      offered.push(b.id);
    } catch (e) {
      console.error(`[job:business-retention] final export for ${b.id} failed`, e);
    }
  }
  const resumed: string[] = [];
  for (const t of await db.businessTombstone.findMany({ where: { completedAt: null }, select: { id: true } })) {
    try {
      await runPurge(t.id);
      resumed.push(t.id);
    } catch (e) {
      console.error(`[job:business-retention] purge of ${t.id} failed`, e);
    }
  }
  const archived = await db.business.findMany({ where: { status: "ARCHIVED", deleteAfter: { lte: now } }, select: { id: true, status: true, deleteAfter: true, finalExportAt: true } });
  const awaitingApproval = archived.filter((b) => purgeStatus(b, now).canPurge).map((b) => b.id);
  if (awaitingApproval.length) console.info(`[job:business-retention] ${awaitingApproval.length} archived business(es) past retention await a super admin's approval`);
  return { offered, resumed, awaitingApproval };
}
