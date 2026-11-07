import { getWaConfig, sendWhatsApp } from "./whatsapp";
import { platformPrisma, prisma } from "../db";
import { outboxTask } from "../lib/outbox";
import { currentBusinessId } from "../lib/tenant";
import { env } from "../env";
import { emitToUser } from "../realtime";
import { sendSms } from "./sms";
import { sendMail } from "./mailer";

export interface ChannelPrefs {
  push: boolean;
  sms: boolean;
  email: boolean;
  whatsapp: boolean;
}

const DEFAULT_PREFS: ChannelPrefs = { push: true, sms: false, email: false, whatsapp: false };

/**
 * Resolve channels for an event kind from the GLOBAL `notifications.prefs`
 * setting: exact kind ("attendance.late") → its prefix(es) ("attendance") →
 * "*" → defaults (push only).
 */
export function resolvePrefs(prefs: Record<string, Partial<ChannelPrefs>> | null | undefined, kind: string): ChannelPrefs {
  if (prefs) {
    const parts = kind.split(".");
    for (let i = parts.length; i > 0; i--) {
      const p = prefs[parts.slice(0, i).join(".")];
      if (p) return { ...DEFAULT_PREFS, ...p };
    }
    if (prefs["*"]) return { ...DEFAULT_PREFS, ...prefs["*"] };
  }
  return DEFAULT_PREFS;
}

async function loadPrefs(kind: string): Promise<ChannelPrefs> {
  // Business preferences first, then the platform-wide default.
  const businessId = currentBusinessId();
  const s =
    (businessId && (await prisma.setting.findUnique({ where: { scope_key: { scope: businessId, key: "notifications.prefs" } } }))) ||
    (await prisma.setting.findUnique({ where: { scope_key: { scope: "GLOBAL", key: "notifications.prefs" } } }));
  return resolvePrefs(s?.value as Record<string, Partial<ChannelPrefs>> | undefined, kind);
}

/** Screen to open for each kind of notification (web routes; the mobile app maps them to its screens). */
const DEFAULT_LINKS: [prefix: string, link: string][] = [
  ["delivery", "/delivery"],
  ["order.ready", "/pos"],
  ["order.cancelled", "/bills"],
  ["payment", "/bills"],
  ["kot", "/kitchen"],
  ["table", "/tables"],
  ["reservation", "/reservations"],
  ["leave.request", "/attendance?tab=leaves"],
  ["leave", "/attendance"],
  ["attendance", "/attendance"],
  ["inventory", "/inventory"],
  ["report", "/dashboard"],
  ["crm", "/customers"],
  ["customer", "/customers"],
  ["platform", "/settings"],
];
export const defaultLink = (kind: string) => DEFAULT_LINKS.find(([p]) => kind === p || kind.startsWith(`${p}.`) || kind.startsWith(p))?.[1] ?? null;

export interface NotifyOptions {
  /** Screen to open when tapped; defaults by kind */
  link?: string | null;
  outletId?: string | null;
}

export async function notify(userIds: string[], title: string, body: string, kind: string, opts: NotifyOptions = {}) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const link = opts.link === undefined ? defaultLink(kind) : opts.link;
  const outletId = opts.outletId ?? null;
  const createdAt = new Date();
  const rows = await prisma.notification.createManyAndReturn({
    data: ids.map((userId) => ({ userId, title, body, kind, link, outletId, createdAt })),
    select: { id: true, userId: true },
  });
  // The live event carries the stored id so a toast can mark exactly that row read.
  for (const r of rows) emitToUser(r.userId, "notification", { id: r.id, title, body, kind, link, outletId, createdAt, read: false });
  const idByUser = Object.fromEntries(rows.map((r) => [r.userId, { id: r.id }]));
  // External channels are best-effort and never block / fail the caller.
  // External channels via the outbox: survives a crash and never blocks / fails the caller.
  await outboxTask(platformPrisma, "notify.external", { userIds: ids, title, body, kind, link, outletId, idByUser });
}

/** Outbox task "notify.external": push / SMS / email / WhatsApp for a notification. */
export async function deliverExternal(
  userIds: string[],
  title: string,
  body: string,
  kind: string,
  link: string | null,
  outletId: string | null,
  idByUser: Record<string, Record<string, unknown>>,
) {
  const prefs = await loadPrefs(kind);
  const jobs: Promise<unknown>[] = [];
  if (prefs.push) jobs.push(sendPushToUsers(userIds, title, body, { kind, link, outletId }, idByUser));
  if (prefs.sms || prefs.email || prefs.whatsapp) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, status: "ACTIVE" },
      select: { phone: true, email: true },
    });
    if (prefs.sms) for (const u of users) jobs.push(sendSms(u.phone, `CANAVO: ${title} - ${body}`).catch((e) => console.warn("[notify] sms", e)));
    if (prefs.email) {
      const to = users.map((u) => u.email).filter((e): e is string => Boolean(e));
      if (to.length) {
        jobs.push(sendMail({ to, subject: `CANAVO: ${title}`, html: `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` })
          .catch((e) => console.warn("[notify] email", e)));
      }
    }
    if (prefs.whatsapp) {
      // Staff alerts go only through the business's WhatsApp API (there is nobody to open a click-to-chat link).
      const cfg = await getWaConfig();
      if (cfg.provider !== "NONE" && cfg.staffAlerts) {
        for (const u of users) {
          jobs.push(
            sendWhatsApp({ to: u.phone, text: `${title} - ${body}`, purpose: "staff_alert", tag: `alert_${kind}`, params: [{ name: "title", value: title }, { name: "body", value: body }] }, cfg)
              .then((r) => r.method !== "sent" && console.warn(`[notify] whatsapp staff alert not sent: ${r.error ?? "no provider"}`))
              .catch((e) => console.warn("[notify] whatsapp", e)),
          );
        }
      }
    }
  }
  await Promise.all(jobs);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- Expo push ----------

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export const chunk = <T,>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/**
 * Send an Expo push to every registered device of the users. Batches of ≤100,
 * failures are logged and ignored; tokens reported as DeviceNotRegistered are deleted.
 */
/** Kinds that should ring through Android's "urgent" channel even when the app is closed. */
const URGENT_KINDS = ["kot.new", "order.ready", "delivery", "table.attention", "payment.received"];
export const isUrgentKind = (kind: string) => URGENT_KINDS.some((k) => kind === k || kind.startsWith(`${k}.`));

export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  /** Per-user extra data (e.g. that user's notification id) */
  perUser: Record<string, Record<string, unknown>> = {},
) {
  const devices = await prisma.deviceToken.findMany({ where: { userId: { in: userIds } }, select: { token: true, userId: true } });
  const valid = devices.filter((d) => /^Expo(nent)?PushToken\[.+\]$/.test(d.token));
  const tokens = valid.map((d) => d.token);
  const userOf = new Map(valid.map((d) => [d.token, d.userId]));
  const channelId = typeof data.kind === "string" && isUrgentKind(data.kind) ? "urgent" : "default";
  if (tokens.length === 0) return { sent: 0, removed: 0 };
  console.info(`[push] sending "${title}" to ${tokens.length} device(s)`);
  let sent = 0;
  const stale: string[] = [];
  for (const batch of chunk(tokens, 100)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(env.EXPO_ACCESS_TOKEN && { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` }),
        },
        body: JSON.stringify(
          batch.map((to) => ({ to, title, body, data: { ...data, ...(perUser[userOf.get(to) ?? ""] ?? {}) }, sound: "default", priority: "high", channelId })),
        ),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[push] Expo responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      const json = (await res.json()) as { data?: ExpoTicket[] };
      (json.data ?? []).forEach((t, i) => {
        if (t.status === "ok") sent++;
        else if (t.details?.error === "DeviceNotRegistered") stale.push(batch[i]);
        else console.warn(`[push] ticket error for ${batch[i]}: ${t.message}`);
      });
    } catch (e) {
      console.warn("[push] request failed (ignored):", (e as Error).message);
    }
  }
  if (stale.length) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: stale } } });
    console.info(`[push] removed ${stale.length} unregistered token(s)`);
  }
  console.info(`[push] delivered ${sent}/${tokens.length}`);
  return { sent, removed: stale.length };
}

/** Managers (and super admins) responsible for an outlet. */
export async function outletManagers(outletId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      // Platform super admins don't receive day-to-day alerts of client businesses.
      OR: [
        { role: "BUSINESS_OWNER", business: { outlets: { some: { id: outletId } } } },
        { role: "OUTLET_MANAGER", outlets: { some: { outletId } } },
      ],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}


/** Active staff of an outlet with one of the roles (owners included for manager-level alerts). */
export async function outletStaff(outletId: string, roles: string[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { role: { in: roles as never[] }, outlets: { some: { outletId } } },
        ...(roles.includes("BUSINESS_OWNER") ? [{ role: "BUSINESS_OWNER" as const, business: { outlets: { some: { id: outletId } } } }] : []),
      ],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
