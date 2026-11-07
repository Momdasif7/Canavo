/**
 * QA Phase 7: tenant-integrity SQL, generated from the live PostgreSQL catalog.
 *
 *   DATABASE_URL=… npx tsx scripts/tenant-integrity.ts          # rewrite docs/qa/sql/tenant-integrity.sql
 *   DATABASE_URL=… npx tsx scripts/tenant-integrity.ts --check  # exit 1 if the committed file is stale
 *
 * Every table is given an owner (its business) by following, in order of preference: its own
 * businessId column, a NOT NULL outletId, a NOT NULL foreign key / id reference to an owned
 * table, then a nullable outletId. Every reference column (real FOREIGN KEYs from pg_constraint
 * plus "soft" id columns the schema keeps without a FK: outletId, orderId, createdById …) then
 * gets checks that the row it points to exists (soft refs only — FKs are enforced by the DB),
 * belongs to the SAME business, and — when both sides carry an outletId — to the same outlet.
 * A few array / JSON references and domain rules are added by hand at the end.
 *
 * The result is ONE read-only SELECT returning (check, violations); every count must be 0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CatalogColumn {
  table: string;
  column: string;
  nullable: boolean;
  dataType: string;
}
export interface CatalogFk {
  table: string;
  column: string;
  parent: string;
}
export type Query = <T>(sql: string) => Promise<T[]>;

export const SQL_FILE = path.resolve(__dirname, "../../../docs/qa/sql/tenant-integrity.sql");

/** Tables that are not business data (or are checked by hand below). */
const SKIP_TABLES = new Set(["_prisma_migrations", "Business", "OtpCode", "Setting"]);

/** *Id columns that are not references to a row of ours. */
const NOT_REFS = new Set([
  "id", "clientOrderId", "channelOrderId", "externalStoreId", "externalId", "entityId", "refId", "familyId", "deviceId", "publicToken",
]);

/** Reference columns whose target table isn't simply the column name minus "Id". */
const ALIASES: Record<string, string> = {
  fromOutletId: "Outlet",
  toOutletId: "Outlet",
  soldOutletId: "Outlet",
  agentId: "User",
  waiterId: "User",
  reviewerId: "User",
  billedOrderId: "Order",
  tableSessionId: "TableSession",
  sessionId: "TableSession",
  tableId: "DiningTable",
  areaId: "DiningArea",
  zoneId: "DeliveryZone",
  kotId: "KotTicket",
  variantId: "ItemVariant",
  categoryId: "MenuCategory",
  parentId: "MenuCategory",
  slotId: "MealSlot",
  mealSlotId: "MealSlot",
  subscriptionId: "MealSubscription",
  connectionId: "ChannelConnection",
  accountId: "MealTokenAccount",
  auditId: "StockAudit",
  transferId: "StockTransfer",
  inventoryItemId: "InventoryItem",
};

/**
 * Pairs (child.column) whose outletId may legitimately differ from the parent's outletId.
 * Empty today: every outlet-carrying child must sit at its parent's outlet.
 */
const OUTLET_MISMATCH_ALLOWED = new Set<string>([]);

const q = (s: string) => `"${s}"`;

interface Ref {
  table: string;
  column: string;
  parent: string;
  fk: boolean;
  nullable: boolean;
}

export async function readCatalog(query: Query) {
  const columns = (
    await query<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>(
      `SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    )
  ).map((c) => ({ table: c.table_name, column: c.column_name, nullable: c.is_nullable === "YES", dataType: c.data_type }));
  const fks = await query<CatalogFk>(
    `SELECT k.conrelid::regclass::text AS "table", a.attname AS "column", k.confrelid::regclass::text AS parent
       FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND array_length(k.conkey, 1) = 1
      ORDER BY 1, 2`,
  );
  return { columns, fks: fks.map((f) => ({ ...f, table: f.table.replace(/"/g, ""), parent: f.parent.replace(/"/g, "") })) };
}

export function generate({ columns, fks }: { columns: CatalogColumn[]; fks: CatalogFk[] }): string {
  const tables = [...new Set(columns.map((c) => c.table))].filter((t) => !SKIP_TABLES.has(t)).sort();
  const allTables = new Set(columns.map((c) => c.table));
  const col = (t: string, c: string) => columns.find((x) => x.table === t && x.column === c);
  const hasId = (t: string) => !!col(t, "id");

  // ---- references --------------------------------------------------------------------------
  const refs: Ref[] = [];
  const unmapped: string[] = [];
  for (const c of columns) {
    if (SKIP_TABLES.has(c.table) || c.dataType !== "text" || NOT_REFS.has(c.column)) continue;
    const fk = fks.find((f) => f.table === c.table && f.column === c.column);
    let parent = fk?.parent;
    if (!parent && /Id$/.test(c.column)) {
      if (/ById$/.test(c.column)) parent = "User";
      else parent = ALIASES[c.column] ?? [...allTables].find((t) => t.toLowerCase() === c.column.slice(0, -2).toLowerCase());
      if (!parent) unmapped.push(`${c.table}.${c.column}`);
    }
    if (parent && hasId(parent)) refs.push({ table: c.table, column: c.column, parent, fk: !!fk, nullable: c.nullable });
  }

  // ---- owner of every table (fixpoint over the preference order) ---------------------------
  type OwnerPath = { kind: "business" } | { kind: "ref"; column: string; parent: string };
  const owner = new Map<string, OwnerPath>();
  owner.set("Business", { kind: "business" }); // sentinel, never used as a child
  for (const t of tables) if (col(t, "businessId")) owner.set(t, { kind: "business" });
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tables) {
      if (owner.has(t)) continue;
      const mine = refs.filter((r) => r.table === t && r.column !== "businessId" && owner.has(r.parent) && r.parent !== t);
      const pick =
        mine.find((r) => r.column === "outletId" && !r.nullable) ??
        mine.find((r) => r.fk && !r.nullable) ??
        mine.find((r) => !r.nullable) ??
        mine.find((r) => r.column === "outletId") ??
        mine[0];
      if (pick) {
        owner.set(t, { kind: "ref", column: pick.column, parent: pick.parent });
        changed = true;
      }
    }
  }
  const unowned = tables.filter((t) => !owner.has(t));

  /** SQL expression for the business id of row `alias` of `table`. */
  let aliasSeq = 0;
  const ownerExpr = (table: string, alias: string): string => {
    const p = owner.get(table)!;
    if (p.kind === "business") return `${alias}."businessId"`;
    const a = `o${++aliasSeq}`;
    return `(SELECT ${ownerExpr(p.parent, a)} FROM ${q(p.parent)} ${a} WHERE ${a}.id = ${alias}.${q(p.column)})`;
  };
  const chainCol = (table: string) => {
    const p = owner.get(table)!;
    return p.kind === "business" ? "businessId" : p.column;
  };

  const checks: { name: string; sql: string }[] = [];
  const add = (name: string, from: string, where: string) => checks.push({ name, sql: `SELECT '${name}'::text AS "check", count(*) AS violations FROM ${from} WHERE ${where}` });

  /** Rows that may legitimately belong to the platform (businessId NULL: platform staff, their tokens, platform audit). */
  const platformCapable = (t: string): boolean => {
    const p = owner.get(t)!;
    return p.kind === "business" ? !!col(t, "businessId")?.nullable : platformCapable(p.parent);
  };

  // 1. every owned row reaches an existing Business (platform-capable rows: unless their chain ends at NULL)
  for (const t of tables.filter((x) => owner.has(x))) {
    aliasSeq = 0;
    const c = chainCol(t);
    const biz = ownerExpr(t, "t");
    add(`chain:${t}.${c}`, `${q(t)} t`, `t.${q(c)} IS NOT NULL AND ${platformCapable(t) ? `${biz} IS NOT NULL AND ` : ""}NOT EXISTS (SELECT 1 FROM "Business" b WHERE b.id = ${biz})`);
  }

  // 2. soft references point at an existing row; 3. same business; 4. same outlet
  for (const r of refs) {
    if (r.parent === "Business") {
      if (!r.fk) add(`orphan:${r.table}.${r.column}`, `${q(r.table)} t`, `t.${q(r.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Business" p WHERE p.id = t.${q(r.column)})`);
      continue;
    }
    if (!r.fk) add(`orphan:${r.table}.${r.column}->${r.parent}`, `${q(r.table)} t`, `t.${q(r.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(r.parent)} p WHERE p.id = t.${q(r.column)})`);
    if (owner.has(r.table) && owner.has(r.parent) && r.column !== chainCol(r.table)) {
      aliasSeq = 0;
      const mine = ownerExpr(r.table, "t");
      const theirs = ownerExpr(r.parent, "p");
      add(
        `cross-business:${r.table}.${r.column}->${r.parent}`,
        `${q(r.table)} t JOIN ${q(r.parent)} p ON p.id = t.${q(r.column)}`,
        `${theirs} IS NOT NULL AND ${mine} IS NOT NULL AND ${theirs} <> ${mine}`,
      );
    }
    if (r.column !== "outletId" && r.parent !== "Outlet" && col(r.table, "outletId") && col(r.parent, "outletId") && !OUTLET_MISMATCH_ALLOWED.has(`${r.table}.${r.column}`)) {
      add(
        `cross-outlet:${r.table}.${r.column}->${r.parent}`,
        `${q(r.table)} t JOIN ${q(r.parent)} p ON p.id = t.${q(r.column)}`,
        `t."outletId" IS NOT NULL AND p."outletId" IS NOT NULL AND t."outletId" <> p."outletId"`,
      );
    }
  }

  // 5. hand-written: array / JSON references, scoped settings, domain consistency
  const extra: [string, string, string][] = [
    ["orphan:Setting.scope", `"Setting" t`, `t.scope <> 'GLOBAL' AND NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = t.scope) AND NOT EXISTS (SELECT 1 FROM "Business" b WHERE b.id = t.scope)`],
    ["role:User.businessId", `"User" t`, `(t.role IN ('SUPER_ADMIN','PLATFORM_SUPPORT')) <> (t."businessId" IS NULL)`],
    ["role:User.customRoleId->CustomRole.baseRole", `"User" t JOIN "CustomRole" p ON p.id = t."customRoleId"`, `p."baseRole" <> t.role`],
    ["cross-business:Offer.outletIds[]->Outlet", `"Offer" t CROSS JOIN LATERAL unnest(t."outletIds") x(id)`, `NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = x.id AND o."businessId" = t."businessId")`],
    ["cross-outlet:TableSession.mergedTableIds[]->DiningTable", `"TableSession" t CROSS JOIN LATERAL unnest(t."mergedTableIds") x(id)`, `NOT EXISTS (SELECT 1 FROM "DiningTable" d WHERE d.id = x.id AND d."outletId" = t."outletId")`],
    ["cross-outlet:ChannelRequest.kotIds[]->KotTicket", `"ChannelRequest" t CROSS JOIN LATERAL unnest(t."kotIds") x(id)`, `NOT EXISTS (SELECT 1 FROM "KotTicket" k WHERE k.id = x.id AND k."outletId" = t."outletId")`],
    ["cross-item:TableSessionItem.addonIds[]->ItemAddon", `"TableSessionItem" t CROSS JOIN LATERAL unnest(t."addonIds") x(id)`, `NOT EXISTS (SELECT 1 FROM "ItemAddon" a WHERE a.id = x.id AND a."menuItemId" = t."menuItemId")`],
    ["cross-item:OutletItemOverride.stockOutVariantIds[]->ItemVariant", `"OutletItemOverride" t CROSS JOIN LATERAL unnest(t."stockOutVariantIds") x(id)`, `NOT EXISTS (SELECT 1 FROM "ItemVariant" v WHERE v.id = x.id AND v."menuItemId" = t."menuItemId")`],
    ["cross-item:OrderItem.variantId->ItemVariant", `"OrderItem" t JOIN "ItemVariant" v ON v.id = t."variantId"`, `v."menuItemId" <> t."menuItemId"`],
    ["cross-item:TableSessionItem.variantId->ItemVariant", `"TableSessionItem" t JOIN "ItemVariant" v ON v.id = t."variantId"`, `v."menuItemId" <> t."menuItemId"`],
    ["cross-item:Recipe.variantId->ItemVariant", `"Recipe" t JOIN "ItemVariant" v ON v.id = t."variantId"`, `v."menuItemId" <> t."menuItemId"`],
    ["cross-business:Reservation.preOrderItems[].menuItemId", `"Reservation" t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."preOrderItems") = 'array' THEN t."preOrderItems" ELSE '[]' END) x(e)`, `x.e ? 'menuItemId' AND NOT EXISTS (SELECT 1 FROM "MenuItem" m JOIN "Outlet" o ON o."businessId" = m."businessId" WHERE m.id = x.e->>'menuItemId' AND o.id = t."outletId")`],
    ["cross-business:ChannelRequest.items[].menuItemId", `"ChannelRequest" t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]' END) x(e)`, `x.e ? 'menuItemId' AND NOT EXISTS (SELECT 1 FROM "MenuItem" m JOIN "Outlet" o ON o."businessId" = m."businessId" WHERE m.id = x.e->>'menuItemId' AND o.id = t."outletId")`],
    ["cross-session:KotTicket.orderId/sessionId", `"KotTicket" t JOIN "Order" o ON o.id = t."orderId"`, `t."sessionId" IS NOT NULL AND o."tableSessionId" IS NOT NULL AND o."tableSessionId" <> t."sessionId"`],
    ["cross-customer:MealTokenTxn.customerId/accountId", `"MealTokenTxn" t JOIN "MealTokenAccount" a ON a.id = t."accountId"`, `a."customerId" <> t."customerId"`],
    ["cross-outlet:MealSubscription.slotId->MealSlot", `"MealSubscription" t JOIN "MealSlot" s ON s.id = t."slotId"`, `s."outletId" <> t."outletId"`],
    ["cross-outlet:StockTransfer.from=to", `"StockTransfer" t`, `t."fromOutletId" = t."toOutletId"`],
  ];
  for (const [name, from, where] of extra) add(name, from, where);

  const header = [
    "-- QA Phase 7 — tenant integrity checks. GENERATED by apps/api/scripts/tenant-integrity.ts from the",
    "-- PostgreSQL catalog (do not edit by hand; re-run the script after a schema change).",
    "-- One read-only SELECT: every row of the result must have violations = 0.",
    "-- Run on a live database read-only, e.g.:",
    "--   BEGIN READ ONLY; SET LOCAL app.bypass_rls = 'on'; SET LOCAL jit = off; \\i docs/qa/sql/tenant-integrity.sql  ROLLBACK;",
    "--",
    "-- Kinds: chain:T.c                every row of T reaches an existing Business through c",
    "--        orphan:T.c->P            soft reference (no FOREIGN KEY) points at a missing P row",
    "--        cross-business:T.c->P    T's business differs from the business of the P row it references",
    "--        cross-outlet:T.c->P      both carry outletId and they differ",
    "--        cross-item / role / …   hand-written array, JSON and domain checks",
    `-- Owner paths: ${tables.filter((t) => owner.has(t)).map((t) => `${t}.${chainCol(t)}`).join(", ")}`,
    `-- Tables without an owner path (not checked): ${unowned.join(", ") || "none"}`,
    `-- *Id columns with no known target (not checked): ${unmapped.join(", ") || "none"}`,
    `-- ${checks.length} checks.`,
  ];
  return `${header.join("\n")}\nSELECT "check", violations FROM (\n${checks.map((c) => `  ${c.sql}`).join("\nUNION ALL\n")}\n) c\nORDER BY violations DESC, "check";\n`;
}

export async function generateFrom(query: Query) {
  return generate(await readCatalog(query));
}

if (typeof require !== "undefined" && require.main === module) {
  void (async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    const sql = await generateFrom((s) => p.$queryRawUnsafe(s));
    await p.$disconnect();
    if (process.argv.includes("--check")) {
      const same = readFileSync(SQL_FILE, "utf8") === sql;
      console.info(same ? "tenant-integrity.sql is up to date" : "tenant-integrity.sql is STALE — re-run without --check");
      process.exit(same ? 0 : 1);
    }
    writeFileSync(SQL_FILE, sql);
    console.info(`wrote ${SQL_FILE}`);
  })();
}
