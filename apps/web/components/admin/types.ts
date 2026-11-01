import type { ReportKey, SettingKey } from "@canavo/shared";

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  outletId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  meta: unknown;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; role: string } | null;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface BackupFile {
  file: string;
  size: number;
  createdAt: string;
  kind: "auto" | "manual";
  /** local = this server only; offsite = off-site copy only (written by the worker); both */
  location?: "local" | "offsite" | "both";
}

export interface BackupResult {
  file: string;
  size: number;
  rows: number;
  counts: Record<string, number>;
}

export interface ReportSchedule {
  id: string;
  outletId: string;
  email: string;
  frequency: "DAILY" | "WEEKLY";
  reports: ReportKey[];
  active: boolean;
  lastSentAt: string | null;
  createdAt: string;
}

export interface SendNowResult {
  delivered: boolean;
  messageId?: string;
  outboxPath?: string;
  subject: string;
  from: string;
  to: string;
  attachments: string[];
}

export interface SettingsIndex {
  keys: SettingKey[];
  defaults: Record<SettingKey, unknown>;
  globalOnly: SettingKey[];
}

export interface SettingValue<T = unknown> {
  scope: string;
  key: SettingKey;
  value: T;
  isDefault?: boolean;
  updatedAt: string | null;
}

export interface AadhaarResponse {
  userId: string;
  aadhaar: string | null;
  revealed?: boolean;
  /** The full number is on file (encrypted); otherwise only the last 4 digits */
  fullStored?: boolean;
  mode?: "LAST4" | "FULL";
  consent?: { at: string; byId: string | null; version: string | null } | null;
}

export interface AadhaarSettings {
  mode: "LAST4" | "FULL";
  fullNumbersStored: number;
}
