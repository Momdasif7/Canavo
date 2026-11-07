import type { Request } from "express";
import type { ApprovalAction, Prisma } from "@prisma/client";
import { canWith, type Permission } from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { HttpError } from "../lib/http";
import { verifyPin } from "../lib/pin";
import { featureOn } from "../lib/tenant";
import { notify, outletManagers } from "./notify";
import { userCan } from "../middleware/auth";

/**
 * Manager approvals at the counter (Phase 3.3, feature APPROVAL_PINS).
 *
 * With the flag on, voids, refunds, cash pay-outs and discounts above the outlet's limit need
 * someone with `approval:grant` (owner / outlet manager). Either they do it themselves (logged
 * as self-approved), or the cashier's request carries `approval: { approverId, pin }` and the
 * manager types their PIN on the cashier's device. Wrong PINs use the clock-in lockout.
 * Every approval is written to ApprovalLog (the exceptions report).
 *
 * With the flag off nothing changes: routes keep their old permission checks.
 */
export interface ApprovalInput {
  approverId: string;
  pin: string;
}

export interface ApprovalRequest {
  action: ApprovalAction;
  outletId: string;
  orderId?: string;
  amount: number;
  reason?: string;
  approval?: ApprovalInput;
}

export const approvalsOn = () => featureOn("APPROVAL_PINS");

const LABELS: Record<ApprovalAction, string> = { DISCOUNT: "this discount", VOID: "voiding this bill", REFUND: "this refund", CASH_PAYOUT: "this cash pay-out" };

/** Throw 403 APPROVAL_REQUIRED unless the request is approved; returns the approver's id. Logs the approval. */
export async function requireApproval(req: Request, r: ApprovalRequest, tx: Prisma.TransactionClient = prisma): Promise<string> {
  const me = req.user!;
  let approverId: string;
  if (userCan(req, "approval:grant")) {
    approverId = me.id;
  } else {
    if (!r.approval) {
      throw new HttpError(403, `A manager's approval is needed for ${LABELS[r.action]}.`, { code: "APPROVAL_REQUIRED", action: r.action });
    }
    const approver = await platformPrisma.user.findFirst({
      where: { id: r.approval.approverId, businessId: me.businessId, status: "ACTIVE" },
      select: { id: true, name: true, role: true, customRole: { select: { permissions: true } }, pinHash: true, pinFailedAttempts: true, pinLockedUntil: true, outlets: { select: { outletId: true } } },
    });
    const worksHere = approver && (approver.role === "BUSINESS_OWNER" || approver.outlets.some((o) => o.outletId === r.outletId));
    if (!approver || !worksHere || !canWith(approver.role, "approval:grant", approver.customRole?.permissions)) {
      throw new HttpError(403, "That person can't approve at this outlet.", { code: "APPROVER_INVALID" });
    }
    await verifyPin(approver, r.approval.pin, {
      label: approver.name,
      onLocked: async () =>
        notify(await outletManagers(r.outletId), "Approval PIN locked", `Wrong approval PIN for ${approver.name} entered 5 times. Their PIN is locked for 15 minutes.`, "approval.pin_locked"),
    });
    approverId = approver.id;
  }
  await tx.approvalLog.create({
    data: { outletId: r.outletId, action: r.action, orderId: r.orderId, requestedById: me.id, approvedById: approverId, amount: r.amount, reason: r.reason },
  });
  return approverId;
}

/**
 * Route guard for actions that used to need one permission (e.g. order:cancel to void): allowed
 * with that permission as before, or — with APPROVAL_PINS on — by anyone with `fallback`
 * (e.g. payment:collect) whose request is approved.
 */
export function canActWithApproval(req: Request, permission: Permission, fallback: Permission): "direct" | "approval" | false {
  if (userCan(req, permission)) return "direct";
  if (approvalsOn() && userCan(req, fallback)) return "approval";
  return false;
}

/** Bills synced from offline devices couldn't be approved at the time: logged unapproved for the report. */
export async function logUnapproved(tx: Prisma.TransactionClient, r: Omit<ApprovalRequest, "approval"> & { requestedById: string }) {
  await tx.approvalLog.create({
    data: { outletId: r.outletId, action: r.action, orderId: r.orderId, requestedById: r.requestedById, approvedById: null, amount: r.amount, reason: r.reason ?? "Offline bill: not approved at the time" },
  });
}

/** Approvers available at an outlet (for the PIN dialog). */
export async function approversFor(outletId: string, businessId: string) {
  const users = await platformPrisma.user.findMany({
    where: {
      businessId,
      status: "ACTIVE",
      pinHash: { not: null },
      OR: [{ role: "BUSINESS_OWNER" }, { role: "OUTLET_MANAGER", outlets: { some: { outletId } } }],
    },
    select: { id: true, name: true, role: true, customRole: { select: { permissions: true } } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  // A custom role may have taken approvals away (Phase 4.2).
  return users.filter((u) => canWith(u.role, "approval:grant", u.customRole?.permissions)).map(({ customRole: _c, ...u }) => u);
}
