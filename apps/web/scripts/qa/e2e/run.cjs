#!/usr/bin/env node
/* eslint-disable */
/**
 * Runs every web UI suite in order and prints one summary. See README.md for the environment.
 *   PW_PATH=/path/to/node_modules/playwright node apps/web/scripts/qa/e2e/run.cjs
 * SUITES=journeys,browsers,network,visual,a11y,robust (default: all)
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (!process.env.PW_PATH) {
  console.error("Set PW_PATH to an installed playwright package (see README.md).");
  process.exit(2);
}
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "e2e-out");
const SUITES = (process.env.SUITES || "journeys,browsers,network,visual,a11y,robust").split(",");
const rows = [];
for (const s of SUITES) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, `${s}.cjs`)], { stdio: "inherit", env: { ...process.env, OUT_DIR: OUT } });
  let passed = 0, total = 0;
  try {
    const res = JSON.parse(fs.readFileSync(path.join(OUT, `${s}.json`), "utf8"));
    total = res.length;
    passed = res.filter((x) => x.ok).length;
  } catch {}
  rows.push({ suite: s, passed, total, exit: r.status, secs: Math.round((Date.now() - t) / 1000) });
}
console.log("\n== summary");
for (const r of rows) console.log(`${r.exit === 0 ? "PASS" : "FAIL"} ${r.suite.padEnd(9)} ${r.passed}/${r.total} checks  ${r.secs}s`);
process.exit(rows.every((r) => r.exit === 0) ? 0 : 1);
