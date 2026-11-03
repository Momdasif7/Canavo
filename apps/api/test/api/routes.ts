/**
 * Route inventory for the API test suite (QA Phase 6): every endpoint the Express app
 * serves, with its full path, read from the real routers — so a new route is covered
 * by the sweeps (auth, validation, OpenAPI contract) without anyone listing it.
 */
import express, { type Router } from "express";
import { createApp } from "../../src/app";

export interface RouteInfo {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Express path, e.g. /orders/:id/cancel */
  path: string;
  /** Mounted router variable (for grouping), e.g. "/orders" */
  mount: string;
}

type Layer = { route?: { path: string | string[]; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };

let cached: RouteInfo[] | undefined;

/** Build the app once while recording each app.use(path, router) mount. */
export function listRoutes(): RouteInfo[] {
  if (cached) return cached;
  const mounts: { path: string; router: Router }[] = [];
  const proto = express.application as unknown as { use: (...a: unknown[]) => unknown };
  const original = proto.use;
  proto.use = function (this: unknown, ...args: unknown[]) {
    const [first, ...rest] = args;
    if (typeof first === "string") for (const r of rest) if (typeof r === "function" && (r as { stack?: unknown }).stack) mounts.push({ path: first, router: r as Router });
    if (typeof first === "function" && (first as { stack?: unknown }).stack) mounts.push({ path: "", router: first as Router });
    return original.apply(this, args);
  };
  try {
    createApp();
  } finally {
    proto.use = original;
  }
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  for (const m of mounts) {
    for (const layer of (m.router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      for (const p of [layer.route.path].flat()) {
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (!on || method === "_all" || !["get", "post", "put", "patch", "delete"].includes(method)) continue;
          const path = `${m.path}${p === "/" && m.path ? "" : p}` || "/";
          const key = `${method} ${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ method: method as RouteInfo["method"], path, mount: m.path || "(root)" });
        }
      }
    }
  }
  return (cached = out);
}

/** Fill :params with a well-formed id that exists nowhere (cuid-shaped). */
export const fillParams = (path: string, value = "cl0000000000000000000000") => path.replace(/:([A-Za-z0-9_]+)/g, () => value);

/** OpenAPI-style path: /orders/{id}. */
export const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
