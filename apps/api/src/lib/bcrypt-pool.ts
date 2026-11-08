import os from "node:os";
import { Worker } from "node:worker_threads";
import bcryptjs from "bcryptjs";

/**
 * bcrypt off the event loop (QA Phase 13 perf-2). bcryptjs is pure JavaScript: one cost-10 compare is
 * ~70 ms of CPU on the API's only thread, so a shift-start login storm (100 staff at once) stalled
 * every bill and KDS request for seconds. Same API as bcryptjs' compare / hash; the work runs on a
 * small pool of worker threads (falls back to bcryptjs in-process if workers can't start).
 */
const SIZE = Math.max(1, Math.min(Number(process.env.BCRYPT_THREADS) || 4, os.cpus().length - 1));
const SOURCE = `
const { parentPort } = require("node:worker_threads");
const bcrypt = require(${JSON.stringify(require.resolve("bcryptjs"))});
parentPort.on("message", ({ id, op, a, b }) => {
  try {
    parentPort.postMessage({ id, r: op === "compare" ? bcrypt.compareSync(a, b) : bcrypt.hashSync(a, b) });
  } catch (e) {
    parentPort.postMessage({ id, e: String((e && e.message) || e) });
  }
});`;

type Job = { resolve: (v: unknown) => void; reject: (e: Error) => void };
const workers: { w: Worker; busy: number }[] = [];
const jobs = new Map<number, Job>();
let seq = 0;
let disabled = false;

function pick() {
  if (disabled) return null;
  if (workers.length < SIZE) {
    try {
      const w = new Worker(SOURCE, { eval: true });
      const slot = { w, busy: 0 };
      w.unref();
      w.on("message", (m: { id: number; r?: unknown; e?: string }) => {
        slot.busy--;
        const job = jobs.get(m.id);
        jobs.delete(m.id);
        if (m.e !== undefined) job?.reject(new Error(m.e));
        else job?.resolve(m.r);
      });
      w.on("error", () => {
        workers.splice(workers.indexOf(slot), 1);
        disabled = workers.length === 0;
      });
      workers.push(slot);
    } catch {
      disabled = workers.length === 0;
    }
  }
  return workers.reduce<(typeof workers)[number] | null>((best, s) => (!best || s.busy < best.busy ? s : best), null);
}

function run<T>(op: "compare" | "hash", a: string, b: string | number, inline: () => Promise<T>): Promise<T> {
  const slot = pick();
  if (!slot) return inline();
  const id = ++seq;
  slot.busy++;
  return new Promise<T>((resolve, reject) => {
    jobs.set(id, { resolve: resolve as (v: unknown) => void, reject });
    slot.w.postMessage({ id, op, a, b });
  });
}

export const bcrypt = {
  compare: (data: string, hash: string): Promise<boolean> => run("compare", data, hash, () => bcryptjs.compare(data, hash)),
  hash: (data: string, rounds: number): Promise<string> => run("hash", data, rounds, () => bcryptjs.hash(data, rounds)),
};
