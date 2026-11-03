/**
 * One-off helper (QA Phase 6): print Op[] entries for served endpoints missing from the OpenAPI
 * index, using each route's JSDoc comment and the zod schema its handler parses.
 *   npx tsx --env-file=.env scripts/gen-openapi-stubs.ts > /tmp/ops.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as shared from "@canavo/shared";
import { openapi } from "../src/openapi";
import { listRoutes, toOpenApiPath } from "../test/api/routes";

const PUBLIC = /^\/(public|webhooks)\/|^\/auth\/(login|otp|refresh|logout|cookie-probe|2fa\/verify|password\/(forgot|reset))$|^\/channels\/hub\//;
const dir = path.join(__dirname, "../src/routes");
const sources = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8"));
// Mount path → router variable (app.ts), so "/" routes are looked up in the right file.
const app = readFileSync(path.join(__dirname, "../src/app.ts"), "utf8");
const routerOf = new Map([...app.matchAll(/app\.use\("([^"]+)",\s*(\w+Router)\)/g)].map((m) => [m[1]!, m[2]!]));
const documented = new Set(Object.entries(openapi.paths).flatMap(([p, ms]) => Object.keys(ms).map((m) => `${m} ${p}`)));

const TAGS: Record<string, string> = { "/support-access": "Support", "/cash-shifts": "Cash shifts", "/gift-cards": "Gift cards", "/channels/board": "Channels", "(root)": "Public" };
const tagOf = (mount: string) => TAGS[mount] ?? mount.slice(1).replace(/^./, (c) => c.toUpperCase()).replace(/-./g, (c) => " " + c[1]!.toUpperCase());

function describeRoute(mount: string, method: string, localPath: string): { summary: string; schema?: string } {
  const needle = new RegExp(`${routerOf.get(mount) ?? "\\w+Router"}\\.${method}\\(\\s*"${localPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`);
  for (const src of sources) {
    const m = needle.exec(src);
    if (!m) continue;
    const before = src.slice(0, m.index);
    // Only the comment directly above the route (a JSDoc block or // lines), never one further up.
    const open = before.lastIndexOf("/**");
    const jsdoc = open >= 0 && /^\/\*\*[\s\S]*?\*\/\s*$/.test(before.slice(open)) ? before.slice(open + 3, before.lastIndexOf("*/")) : null;
    const lines = jsdoc === null ? /((?:[ \t]*\/\/[^\n]*\n)+)\s*$/.exec(before)?.[1] : null;
    const text = (jsdoc ?? lines ?? "").replace(/^\s*\*\s?|^\s*\/\/\s?/gm, "").replace(/-{3,}/g, "").replace(/\s+/g, " ").trim();
    const body = src.slice(m.index, m.index + 2500);
    const end = body.slice(1).search(/\n\w+Router\.(get|post|put|patch|delete|use)\(/);
    const handler = end > 0 ? body.slice(0, end + 1) : body;
    const schema = /parse\(\s*([a-z][A-Za-z0-9]*Schema)\b/.exec(handler)?.[1];
    return { summary: text.split(/(?<!\be\.g\.)(?<=\.)\s/)[0]!.replace(/^=+\s*/, "").slice(0, 220), schema };
  }
  return { summary: "" };
}

for (const r of listRoutes()) {
  const key = `${r.method} ${toOpenApiPath(r.path)}`;
  if (documented.has(key)) continue;
  const local = r.mount === "(root)" ? r.path : r.path.slice(r.mount.length) || "/";
  const { summary, schema } = describeRoute(r.mount, r.method, local);
  const words = summary || `${r.method.toUpperCase()} ${r.path}`;
  // "Body: x" only for schemas the exporter can resolve (shared); route-local ones are named plainly.
  const body = schema ? (schema in shared ? (r.method === "get" ? ` Query: ${schema}` : ` Body: ${schema}`) : ` Body validated by ${schema} (route-local)`) : "";
  const full = `${words}${body && !/[.)]$/.test(words) ? "." : ""}${body}`;
  const secured = !PUBLIC.test(r.path);
  console.log(`  [${JSON.stringify(r.method)}, ${JSON.stringify(toOpenApiPath(r.path))}, ${JSON.stringify(full)}, ${JSON.stringify(tagOf(r.mount))}${secured ? "" : ", false"}],`);
}
