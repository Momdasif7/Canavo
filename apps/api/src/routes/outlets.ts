import { Router } from "express";
import { outletSchema, shiftSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { emitToOutlet } from "../realtime";
import { requireBusinessId } from "../lib/tenant";
import { badRequest, forbidden, param, parse } from "../lib/http";
import { authenticate, requireOutlet, requirePermission, userCan } from "../middleware/auth";

export const outletsRouter = Router();
outletsRouter.use(authenticate);

/** Fields that change how bills are taxed/numbered: need settings:billing. */
const BILLING_FIELDS = ["gstEnabled", "invoicePrefix", "compositionScheme", "pricesIncludeTax", "flatDiscountsIncludeTax"] as const;

/**
 * Cross-field GST rules on the resulting outlet state. Composition is a
 * registered mode, so it needs GST on; GST on without a GSTIN is allowed (with
 * a warning) so a business can switch on before the GSTIN is entered.
 */
/** Every date screen formats with the outlet's timezone: an unknown IANA name would make them all fail. */
function assertTimezone(tz: string | undefined) {
  if (tz === undefined) return;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    throw badRequest("Validation failed", { fieldErrors: { timezone: ["Unknown timezone, e.g. Asia/Kolkata"] } });
  }
}

function gstRules(
  o: { gstEnabled: boolean; compositionScheme: boolean; gstin: string | null; stateCode: string; fssai: string | null },
  checkState = true,
): string[] {
  if (o.compositionScheme && !o.gstEnabled) throw badRequest("Composition scheme requires GST to be enabled");
  // QA Phase 14: a GSTIN is registered per state; its first two digits are that state's code (the
  // outlet's place of supply). A mismatch would print a wrong GSTIN / place of supply on every invoice.
  if (checkState && o.gstin && o.gstin.slice(0, 2) !== o.stateCode) {
    throw badRequest("Validation failed", { fieldErrors: { gstin: [`This GSTIN is registered in state ${o.gstin.slice(0, 2)}, but the outlet's state code is ${o.stateCode}`] } });
  }
  const warnings: string[] = [];
  if (o.gstEnabled && !o.gstin) warnings.push("GST is enabled but no GSTIN is set. Add the GSTIN so it prints on tax invoices.");
  if (!o.fssai) warnings.push("No FSSAI licence number is set. Food businesses must print it on bills (FSSAI order, 2021).");
  return warnings;
}

/**
 * Staff without settings access (kitchen, delivery, inventory) only get what
 * their screens need — not GSTIN, UPI ID, licences or billing configuration.
 */
const BASIC_OUTLET_FIELDS = {
  id: true,
  businessId: true,
  name: true,
  address: true,
  phone: true,
  logoUrl: true,
  timezone: true,
  latitude: true,
  longitude: true,
  geofenceMeters: true,
  posShowImages: true,
  gstEnabled: true,
  deliveryEnabled: true,
  deliveryAddressMode: true,
} as const;

const outletSelect = (req: Express.Request) => (userCan(req, "settings:view") ? undefined : BASIC_OUTLET_FIELDS);

outletsRouter.get("/", async (req, res) => {
  // Platform super admins have no outlets (they don't see hotel data).
  res.json(await prisma.outlet.findMany({ where: { id: { in: req.user!.outletIds } }, orderBy: { name: "asc" }, select: outletSelect(req) }));
});

outletsRouter.post("/", requirePermission("outlet:manage"), async (req, res) => {
  const data = parse(outletSchema, req.body);
  assertTimezone(data.timezone);
  const warnings = gstRules({ gstEnabled: data.gstEnabled, compositionScheme: data.compositionScheme, gstin: data.gstin || null, stateCode: data.stateCode, fssai: data.fssai || null });
  const outlet = await prisma.outlet.create({
    data: {
      ...data,
      gstin: data.gstin || null,
      fssai: data.fssai || null,
      logoUrl: data.logoUrl || null,
      legalName: data.legalName || null,
      businessId: requireBusinessId(),
    },
  });
  await audit(req, "outlet.create", "Outlet", outlet.id);
  res.status(201).json({ ...outlet, ...(warnings.length && { warnings }) });
});

/** The active outlet (from X-Outlet-Id). */
outletsRouter.get("/current", requireOutlet, async (req, res) => {
  res.json(await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: outletSelect(req) }));
});

outletsRouter.patch("/current", requireOutlet, requirePermission("settings:outlet"), async (req, res) => {
  const data = parse(outletSchema.partial(), req.body);
  assertTimezone(data.timezone);
  if (BILLING_FIELDS.some((f) => data[f] !== undefined) && !userCan(req, "settings:billing")) {
    throw forbidden("You don't have permission to change billing / GST settings");
  }
  // The approval limit guards managers' own discounts: only the owner changes it (Phase 3.3).
  if (data.approvalDiscountPercent !== undefined && !userCan(req, "outlet:manage")) throw forbidden("Only the owner can change the approval limit");
  const current = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  // Turning GST off also ends the composition scheme (it is a GST registration type).
  if (data.gstEnabled === false) data.compositionScheme = false;
  const gstin = data.gstin !== undefined ? data.gstin || null : current.gstin;
  const warnings = gstRules({
    gstEnabled: data.gstEnabled ?? current.gstEnabled,
    compositionScheme: data.compositionScheme ?? current.compositionScheme,
    gstin,
    stateCode: data.stateCode ?? current.stateCode,
    fssai: data.fssai !== undefined ? data.fssai || null : current.fssai,
  }, data.gstin !== undefined || data.stateCode !== undefined);
  const outlet = await prisma.outlet.update({
    where: { id: req.outletId },
    data: {
      ...data,
      ...(data.gstin !== undefined && { gstin: data.gstin || null }),
      ...(data.fssai !== undefined && { fssai: data.fssai || null }),
      ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl || null }),
      ...(data.legalName !== undefined && { legalName: data.legalName || null }),
    },
  });
  const changed = BILLING_FIELDS.filter((f) => data[f] !== undefined && data[f] !== current[f]);
  await audit(req, "outlet.update", "Outlet", outlet.id, {
    fields: Object.keys(data),
    ...(changed.length && { billing: Object.fromEntries(changed.map((f) => [f, { from: current[f], to: outlet[f] }])) }),
  });
  // Open POS / billing screens on other devices pick up GST & pricing changes immediately.
  emitToOutlet(outlet.id, "outlet:updated", { id: outlet.id, fields: Object.keys(data) });
  res.json({ ...outlet, ...(warnings.length && { warnings }) });
});

// ---------- Shifts ----------
outletsRouter.get("/current/shifts", requireOutlet, async (req, res) => {
  res.json(await prisma.shift.findMany({ where: { outletId: req.outletId }, orderBy: { startTime: "asc" } }));
});

outletsRouter.post("/current/shifts", requireOutlet, requirePermission("staff:manage"), async (req, res) => {
  const data = parse(shiftSchema, req.body);
  res.status(201).json(await prisma.shift.create({ data: { ...data, outletId: req.outletId! } }));
});

outletsRouter.delete("/current/shifts/:id", requireOutlet, requirePermission("staff:manage"), async (req, res) => {
  await prisma.shift.deleteMany({ where: { id: param(req, "id"), outletId: req.outletId } });
  res.status(204).end();
});
