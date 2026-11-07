/**
 * QA Phase 6 — the OpenAPI document and the real routers agree: every served endpoint is
 * documented, nothing documented is gone, and every "Body: xSchema" names a real zod schema
 * (the exporter in scripts/export-api-docs.ts turns those into JSON Schema request bodies).
 */
import { describe, expect, it } from "vitest";
import * as shared from "@canavo/shared";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openapi } from "../../src/openapi";
import { buildDocs } from "../../scripts/export-api-docs";
import { listRoutes, toOpenApiPath } from "./routes";

const served = new Set(listRoutes().map((r) => `${r.method} ${toOpenApiPath(r.path)}`));
const documented = new Map<string, string>();
for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(methods)) documented.set(`${method} ${path}`, (op as { summary: string }).summary);
}

describe("OpenAPI contract", () => {
  it("documents every endpoint the API serves", () => {
    expect([...served].filter((k) => !documented.has(k)).sort()).toEqual([]);
  });

  it("documents nothing the API no longer serves", () => {
    expect([...documented.keys()].filter((k) => !served.has(k)).sort()).toEqual([]);
  });

  it("every named request-body schema exists in @canavo/shared", () => {
    const named = [...documented.values()].flatMap((s) => [...s.matchAll(/(?:Body|Query): ([a-z][A-Za-z0-9]*Schema)\b/g)].map((m) => m[1]!));
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter((n) => !(n in shared)).sort()).toEqual([]);
  });

  it("docs/api/openapi.json and the Postman collection are up to date (npm run docs:api)", () => {
    const { doc, postman } = buildDocs();
    const dir = path.join(__dirname, "../../../../docs/api");
    expect(JSON.parse(readFileSync(path.join(dir, "openapi.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(JSON.parse(readFileSync(path.join(dir, "canavo.postman_collection.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(postman)));
  });

  it("every request body converts to a non-empty JSON Schema", () => {
    const { doc } = buildDocs();
    const empty = Object.entries(doc.components.schemas as Record<string, object>).filter(([, s]) => Object.keys(s).length === 0).map(([k]) => k);
    expect(empty).toEqual([]);
  });
});
