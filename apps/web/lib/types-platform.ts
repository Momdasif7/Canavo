/**
 * Response shapes of the platform console API (/platform/*), used by CANAVO
 * operators (super admins outside any business). The platform sees account
 * info only — never a hotel's sales, bills, staff or customers.
 */
import type { ModuleKey, Role } from "@canavo/shared";
import type { BusinessStatus, StaffStatus } from "./types";

export interface PlatformSummary {
  businesses: number;
  activeBusinesses: number;
  suspendedBusinesses: number;
  outlets: number;
  owners: number;
}

export interface BusinessOwnerRef {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

interface BusinessBase {
  id: string;
  name: string;
  legalName: string | null;
  ownerName: string | null;
  phone: string | null;
  email: string | null;
  status: BusinessStatus;
  modules: ModuleKey[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /platform/businesses row */
export interface BusinessListItem extends BusinessBase {
  _count: { outlets: number };
  owners: BusinessOwnerRef[];
}

export interface PlatformUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: StaffStatus;
  createdAt: string;
  outlets: { outletId: string }[];
}

/** Owner account of a business (the only logins the platform manages inside a hotel). */
export interface BusinessOwner {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: StaffStatus;
  createdAt: string;
  /** Two-step login turned on (null = off) */
  totpEnabledAt?: string | null;
}

export interface BusinessOutlet {
  id: string;
  name: string;
  address: string;
  createdAt: string;
}

/** GET /platform/businesses/:id */
export interface BusinessDetail extends BusinessBase {
  outlets: BusinessOutlet[];
  owners: BusinessOwner[];
  /** Per-hotel feature flags that are on */
  features: Partial<Record<string, boolean>>;
  /** Every flag the platform offers: label, description, required modules */
  featureCatalog: Record<string, { label: string; description: string; requires: ModuleKey[] }>;
}

/** POST /platform/businesses response */
export interface BusinessCreateResult {
  business: BusinessBase;
  outlet: { id: string; name: string } | null;
  owner: PlatformUser;
  invite: LinkDelivery;
}

/** Where a password setup/reset link went (devLink only outside production). */
export interface LinkDelivery {
  channel: "email" | "sms" | "none";
  devLink?: string;
  expiresAt: string;
}
