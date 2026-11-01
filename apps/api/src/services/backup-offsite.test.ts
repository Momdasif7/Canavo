/**
 * API and worker on separate disks (JOBS_MODE=worker): backups the worker wrote reach the
 * API through the off-site store — listed, and fetched to the API disk for a restore.
 */
import { mkdirSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const dirs = vi.hoisted(() => {
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return { storage: mk(join(tmpdir(), "canavo-api-disk-")), offsite: mk(join(tmpdir(), "canavo-offsite-")) };
});

vi.mock("../env", async (importOriginal) => {
  const real = (await importOriginal()) as { env: Record<string, unknown> };
  return { ...real, env: { ...real.env, STORAGE_DIR: dirs.storage, BACKUP_OFFSITE_DIR: dirs.offsite, BACKUP_S3_BUCKET: undefined } };
});

const { assertBackupExists, listBackups, pruneBackups } = await import("./backup");

const WORKER_FILE = "canavo-backup-auto-20261101-013000.ndjson.gz";
const LOCAL_FILE = "canavo-backup-manual-20261101-090000.ndjson.gz";

describe("backups across the API and worker disks", () => {
  it("lists off-site-only backups and marks copies present in both places", async () => {
    mkdirSync(path.join(dirs.storage, "backups"), { recursive: true });
    await writeFile(path.join(dirs.offsite, WORKER_FILE), "worker-backup");
    await writeFile(path.join(dirs.storage, "backups", LOCAL_FILE), "local-backup");
    await writeFile(path.join(dirs.offsite, LOCAL_FILE), "local-backup");
    await writeFile(path.join(dirs.offsite, "notes.txt"), "ignored");

    const list = await listBackups();
    expect(list.map((b) => [b.file, b.location, b.kind]).sort()).toEqual(
      [
        [LOCAL_FILE, "both", "manual"],
        [WORKER_FILE, "offsite", "auto"],
      ].sort(),
    );
  });

  it("fetches an off-site-only backup to this disk before a restore", async () => {
    const p = await assertBackupExists(WORKER_FILE);
    expect(p).toBe(path.join(dirs.storage, "backups", WORKER_FILE));
    expect(await readFile(p, "utf8")).toBe("worker-backup");
    expect((await readdir(path.join(dirs.storage, "backups"))).some((f) => f.endsWith(".download"))).toBe(false);
  });

  it("404s for a backup that is nowhere and rejects path tricks", async () => {
    await expect(assertBackupExists("canavo-backup-auto-20200101-000000.ndjson.gz")).rejects.toMatchObject({ status: 404 });
    await expect(assertBackupExists("../secrets.ndjson.gz")).rejects.toMatchObject({ status: 400 });
  });

  it("prunes local files only (off-site retention belongs to the bucket)", async () => {
    await pruneBackups(0);
    expect(await readdir(path.join(dirs.storage, "backups"))).toEqual([LOCAL_FILE]);
    expect((await readdir(dirs.offsite)).sort()).toEqual([LOCAL_FILE, WORKER_FILE, "notes.txt"].sort());
  });
});
