/**
 * Export the API documentation (QA Phase 6) to docs/api:
 *   - openapi.json: the OpenAPI index (src/openapi.ts) with request bodies / query parameters
 *     turned into JSON Schema from the zod schemas in @canavo/shared that each operation names;
 *   - canavo.postman_collection.json: the same operations as a Postman collection
 *     ({{baseUrl}}, {{accessToken}}, {{outletId}} variables; bodies pre-filled from the schemas).
 *   npm run docs:api -w @canavo/api
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ZodTypeAny } from "zod";
import * as shared from "@canavo/shared";
import { openapi } from "../src/openapi";

type Json = Record<string, unknown>;

/** zod (v3) → JSON Schema, covering the constructs the shared schemas use. */
export function toJsonSchema(schema: ZodTypeAny, depth = 0): Json {
  const def = schema._def as Json & { typeName: string; description?: string };
  const withDesc = (s: Json): Json => (def.description ? { ...s, description: def.description } : s);
  if (depth > 25) return {};
  const inner = (s: unknown) => toJsonSchema(s as ZodTypeAny, depth + 1);
  switch (def.typeName) {
    case "ZodString": {
      const s: Json = { type: "string" };
      for (const c of (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (c.kind === "min") s.minLength = c.value;
        else if (c.kind === "max") s.maxLength = c.value;
        else if (c.kind === "length") s.minLength = s.maxLength = c.value;
        else if (c.kind === "email") s.format = "email";
        else if (c.kind === "url") s.format = "uri";
        else if (c.kind === "uuid") s.format = "uuid";
        else if (c.kind === "datetime") s.format = "date-time";
        else if (c.kind === "date") s.format = "date";
        else if (c.kind === "regex" && c.regex) s.pattern = c.regex.source;
      }
      return withDesc(s);
    }
    case "ZodNumber": {
      const s: Json = { type: "number" };
      for (const c of (def.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? []) {
        if (c.kind === "int") s.type = "integer";
        else if (c.kind === "min") s[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") s[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
      }
      return withDesc(s);
    }
    case "ZodBigInt":
      return withDesc({ type: "integer" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodDate":
      return withDesc({ type: "string", format: "date-time" });
    case "ZodLiteral":
      return withDesc({ enum: [def.value] });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values as string[] });
    case "ZodNativeEnum":
      return withDesc({ enum: Object.values(def.values as object) });
    case "ZodArray": {
      const s: Json = { type: "array", items: inner(def.type) };
      if (def.minLength) s.minItems = (def.minLength as { value: number }).value;
      if (def.maxLength) s.maxItems = (def.maxLength as { value: number }).value;
      return withDesc(s);
    }
    case "ZodTuple":
      return withDesc({ type: "array", items: (def.items as ZodTypeAny[]).map(inner) });
    case "ZodSet":
      return withDesc({ type: "array", uniqueItems: true, items: inner(def.valueType) });
    case "ZodRecord":
    case "ZodMap":
      return withDesc({ type: "object", additionalProperties: inner(def.valueType) });
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = inner(v);
        if (!v.isOptional()) required.push(k);
      }
      const s: Json = { type: "object", properties, ...(required.length && { required }) };
      if (def.unknownKeys === "strict") s.additionalProperties = false;
      return withDesc(s);
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (Array.isArray(def.options) ? def.options : [...(def.options as Map<unknown, ZodTypeAny>).values()]) as ZodTypeAny[];
      return withDesc({ anyOf: options.map(inner) });
    }
    case "ZodIntersection":
      return withDesc({ allOf: [inner(def.left), inner(def.right)] });
    case "ZodOptional":
      return inner(def.innerType);
    case "ZodNullable":
      return withDesc({ ...inner(def.innerType), nullable: true });
    case "ZodDefault":
      return withDesc({ ...inner(def.innerType), default: (def.defaultValue as () => unknown)() });
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodBranded":
      return inner(def.innerType ?? def.type);
    case "ZodEffects":
      return withDesc(inner(def.schema));
    case "ZodPipeline":
      return inner(def.in);
    case "ZodLazy":
      return inner((def.getter as () => ZodTypeAny)());
    default:
      return withDesc({});
  }
}

/** A plausible example value for a JSON Schema (Postman bodies). */
function example(s: Json, depth = 0): unknown {
  if (depth > 6) return null;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.anyOf) return example((s.anyOf as Json[])[0]!, depth + 1);
  if (s.allOf) return Object.assign({}, ...(s.allOf as Json[]).map((x) => example(x, depth + 1)));
  switch (s.type) {
    case "object":
      return Object.fromEntries(Object.entries((s.properties as Record<string, Json>) ?? {}).filter(([k]) => ((s.required as string[]) ?? []).includes(k)).map(([k, v]) => [k, example(v, depth + 1)]));
    case "array":
      return s.minItems ? [example(s.items as Json, depth + 1)] : [];
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return false;
    case "string":
      return s.format === "email" ? "user@example.com" : s.format === "date" ? "2026-11-03" : s.format === "date-time" ? "2026-11-03T10:00:00+05:30" : "string";
    default:
      return null;
  }
}

const schemaOf = (name: string) => (shared as unknown as Record<string, ZodTypeAny | undefined>)[name];

export function buildDocs() {
  const doc = structuredClone(openapi) as typeof openapi & { components: Json & { schemas?: Json } };
  const schemas: Json = {};
  const items: Record<string, Json[]> = {};
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods) as [string, Json & { summary: string; tags: string[]; security?: unknown; parameters?: Json[] }][]) {
      const pathParams = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      if (pathParams.length) op.parameters = [...(op.parameters ?? []), ...pathParams];
      const m = /(Body|Query): ([a-z][A-Za-z0-9]*Schema)\b/.exec(op.summary);
      const zod = m ? schemaOf(m[2]!) : undefined;
      let body: unknown;
      if (m && zod) {
        schemas[m[2]!] ??= toJsonSchema(zod);
        const ref = { $ref: `#/components/schemas/${m[2]}` };
        if (m[1] === "Body") {
          op.requestBody = { required: true, content: { "application/json": { schema: ref } } };
          body = example(schemas[m[2]!] as Json);
        } else {
          const props = ((schemas[m[2]!] as Json).properties as Record<string, Json>) ?? {};
          const req = ((schemas[m[2]!] as Json).required as string[]) ?? [];
          op.parameters = [...(op.parameters ?? []), ...Object.entries(props).map(([name, schema]) => ({ name, in: "query", required: req.includes(name), schema }))];
        }
      }
      op.responses = {
        [method === "post" ? "201" : "200"]: { description: "Success (some POST actions answer 200)" },
        "400": { $ref: "#/components/responses/BadRequest" },
        ...(op.security ? { "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" } } : {}),
        ...(pathParams.length ? { "404": { $ref: "#/components/responses/NotFound" } } : {}),
      };
      const tag = op.tags[0]!;
      (items[tag] ??= []).push({
        name: `${method.toUpperCase()} ${p}`,
        request: {
          method: method.toUpperCase(),
          description: op.summary,
          header: [
            ...(op.security ? [{ key: "Authorization", value: "Bearer {{accessToken}}" }, { key: "X-Outlet-Id", value: "{{outletId}}" }] : []),
            ...(body !== undefined ? [{ key: "Content-Type", value: "application/json" }] : []),
          ],
          url: { raw: `{{baseUrl}}${p.replace(/\{(\w+)\}/g, ":$1")}`, host: ["{{baseUrl}}"], path: p.replace(/\{(\w+)\}/g, ":$1").split("/").filter(Boolean) },
          ...(body !== undefined && { body: { mode: "raw", raw: JSON.stringify(body, null, 2), options: { raw: { language: "json" } } } }),
        },
      });
    }
  }
  const error = { type: "object", required: ["error"], properties: { error: { type: "string" }, details: {}, requestId: { type: "string" } } };
  const resp = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
  doc.components.schemas = { Error: error, ...schemas };
  doc.components.responses = { BadRequest: resp("Validation failed / bad input"), Unauthorized: resp("No or invalid session"), Forbidden: resp("Role, module or outlet not allowed"), NotFound: resp("Not found (or another business's id)") };
  const postman = {
    info: { name: "CANAVO API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json", description: openapi.info.description },
    variable: [
      { key: "baseUrl", value: "http://localhost:4000" },
      { key: "accessToken", value: "" },
      { key: "outletId", value: "" },
    ],
    item: Object.entries(items).map(([name, item]) => ({ name, item })),
  };
  return { doc, postman, schemaCount: Object.keys(schemas).length };
}

if (require.main === module) {
  const out = path.join(__dirname, "../../../docs/api");
  mkdirSync(out, { recursive: true });
  const { doc, postman, schemaCount } = buildDocs();
  writeFileSync(path.join(out, "openapi.json"), JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(path.join(out, "canavo.postman_collection.json"), JSON.stringify(postman, null, 2) + "\n");
  const ops = Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`docs/api: ${ops} operations, ${schemaCount} request schemas`);
}
