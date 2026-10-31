import { ROLES, type Role } from "@canavo/shared";
import type { Me, OutletRef } from "./types";

/** Lower = more authority. Mirrors RANK in apps/api/src/routes/staff.ts. */
const RANK: Record<Role, number> = {
  SUPER_ADMIN: 0,
  BUSINESS_OWNER: 1,
  OUTLET_MANAGER: 2,
  CASHIER: 3,
  KITCHEN: 3,
  DELIVERY: 3,
  INVENTORY_MANAGER: 3,
};

/** Roles that work across the whole business and need no outlet assignment. */
export const isBusinessWideRole = (r: Role) => r === "SUPER_ADMIN" || r === "BUSINESS_OWNER";

/**
 * Roles the current user may give to an account (same rules as the API): only
 * roles strictly below their own. Owners create managers and staff, managers
 * cashier / kitchen / delivery / inventory staff. Owner accounts are created
 * by the CANAVO platform admin (platform console), never from the Staff screen;
 * the platform admin creates no staff at all.
 */
export function assignableRoles(role: Role): Role[] {
  if (role === "SUPER_ADMIN") return [];
  return ROLES.filter((r) => r !== "SUPER_ADMIN" && r !== "BUSINESS_OWNER" && RANK[r] > RANK[role]);
}

/**
 * May `actor` mark / edit `target`'s attendance? Mirrors canManageAttendanceOf
 * in apps/api/src/services/attendance.ts: owners / super admins manage managers
 * and staff, managers manage staff, nobody manages themselves.
 */
export function canManageAttendanceOf(actor: { id: string; role: Role }, target: { id: string; role: Role }): boolean {
  if (actor.id === target.id) return false;
  return RANK[target.role] > RANK[actor.role];
}

export const canManageRole =(myRole: Role, target: Role) => assignableRoles(myRole).includes(target);

/** Outlets of the business the session acts in (platform admins have none: they never open a hotel). */
export function businessOutlets(me: Pick<Me, "platformAdmin" | "outlets">): OutletRef[] {
  return me.platformAdmin ? [] : me.outlets;
}
