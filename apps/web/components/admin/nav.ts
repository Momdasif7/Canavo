import type { Permission } from "@canavo/shared";
import { CalendarCheck, ClockCounterClockwise, Database, DownloadSimple, IdentificationCard, SlidersHorizontal, type Icon } from "@phosphor-icons/react";

export interface AdminSection {
  href: string;
  label: string;
  icon: Icon;
  /** Visible when the session has any of these (effective) permissions */
  anyOf: Permission[];
  /** See NavItem.scope — "business" (default) needs an outlet, "platform" is platform-console only, "any" works in both */
  scope?: "business" | "platform" | "any";
}

/** Admin area sections (also used for the sidebar "Admin" group). */
export const ADMIN_SECTIONS: AdminSection[] = [
  // The platform admin's audit log holds platform actions only; business roles see their business's.
  { href: "/admin/audit", label: "Audit log", icon: ClockCounterClockwise, anyOf: ["audit:view"], scope: "any" },
  // Platform backups (disaster recovery, no download) — platform console only.
  { href: "/admin/backups", label: "Backups", icon: Database, anyOf: ["admin:backup"], scope: "platform" },
  // Owners download their own business's data.
  { href: "/admin/export", label: "Export data", icon: DownloadSimple, anyOf: ["data:export"] },
  { href: "/admin/schedules", label: "Report schedules", icon: CalendarCheck, anyOf: ["settings:outlet"] },
  // Platform admin: GLOBAL settings only (IP whitelist…); owners / managers: their outlet's too.
  { href: "/admin/settings", label: "System settings", icon: SlidersHorizontal, anyOf: ["settings:outlet", "platform:manage"], scope: "any" },
  { href: "/admin/staff-aadhaar", label: "Staff Aadhaar", icon: IdentificationCard, anyOf: ["staff:manage"] },
];
