/**
 * BUG-014 guard: a `void someAsync()` whose promise can reject is an unhandled
 * rejection, and Node (>=15) terminates the process on those — one failed
 * notification during a DB blip would take the API down for every tenant.
 *
 * Every `void <call>` in apps/api/src must either end with `.catch(...)` or call
 * an alert helper from services/alerts.ts (all of which wrap their work in
 * `safe()`, verified below).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "../../src");
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });

/** The full statement text starting at `void`, up to the first `;` at bracket depth 0. */
function statementAt(src: string, i: number) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth <= 0) return src.slice(i, j);
    if (depth < 0) return src.slice(i, j);
  }
  return src.slice(i);
}

describe("@regression fire-and-forget promises cannot crash the process (BUG-014)", () => {
  it("SA-ASYNC-001 every alert helper is wrapped in safe()", () => {
    const alerts = fs.readFileSync(path.join(SRC, "services/alerts.ts"), "utf8");
    const fns = [...alerts.matchAll(/export function (alert\w+)\([^)]*\)[^{]*\{\s*(\S+)/g)];
    expect(fns.length).toBeGreaterThan(5);
    for (const [, name, first] of fns) expect(first, `${name} must start with \`return safe(\``).toBe("return");
    for (const [, name] of fns) expect(alerts).toMatch(new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{\\s*return safe\\(`));
  });

  it("SA-ASYNC-002 every `void <call>` is caught or is a safe alert helper", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bvoid\s+([\w.]+)\(/g)) {
        const stmt = statementAt(src, m.index);
        const callee = m[1];
        const ok = /\.catch\(/.test(stmt) || /^alert[A-Z]\w*$/.test(callee) || callee === "req" || callee.endsWith(".push") // sync
          || callee === "socket.join"; // void with the in-memory adapter (single instance)
        if (!ok) offenders.push(`${path.relative(SRC, f)}:${src.slice(0, m.index).split("\n").length} void ${callee}(…)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
