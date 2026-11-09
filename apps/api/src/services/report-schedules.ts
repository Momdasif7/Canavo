import type { ReportSchedule } from "@prisma/client";
import type { ReportKey } from "@canavo/shared";
import { prisma } from "../db";
import { addDays } from "../lib/time";
import { buildReport, localParts, summaryHtml } from "../routes/reports";
import { toXlsx } from "./report-export";
import { sendMail } from "./mailer";

/** Period covered by a scheduled email: DAILY = today (local), WEEKLY = previous 7 days ending yesterday. */
export function schedulePeriod(frequency: string, today: string) {
  return frequency === "WEEKLY" ? { from: addDays(today, -7), to: addDays(today, -1) } : { from: today, to: today };
}

/** Is a schedule due at `now` (hourly job)? Daily: after 22:00 local, once per local day. Weekly: Mondays from 06:00, once. */
export function isDue(s: Pick<ReportSchedule, "frequency" | "lastSentAt" | "active">, now: Date, timezone: string): boolean {
  if (!s.active) return false;
  const local = localParts(now, timezone);
  const sentToday = s.lastSentAt ? localParts(s.lastSentAt, timezone).date === local.date : false;
  if (sentToday) return false;
  if (s.frequency === "WEEKLY") return local.weekday === 0 && local.hour >= 6;
  return local.hour >= 22;
}

export async function sendSchedule(s: ReportSchedule, now = new Date()) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: s.outletId } });
  const today = localParts(now, outlet.timezone).date;
  const { from, to } = schedulePeriod(s.frequency, today);
  const attachments = [];
  const sections: string[] = [];
  for (const key of s.reports as ReportKey[]) {
    try {
      const built = await buildReport(key, outlet, from, to);
      attachments.push({
        filename: `${key}_${from}_${to}.xlsx`,
        content: await toXlsx(built.tables),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      sections.push(summaryHtml(built));
    } catch (e) {
      console.error(`[schedule] report ${key} failed`, e);
      sections.push(`<h3>${key}</h3><p style="color:#b00">Could not generate this report.</p>`);
    }
  }
  const period = from === to ? from : `${from} to ${to}`;
  const subject = `${outlet.name} — ${s.frequency === "WEEKLY" ? "weekly" : "daily"} report ${period}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<h2 style="color:#C2410C;margin:0">CANAVO · ${escape(outlet.name)}</h2>
<p style="color:#666;margin:4px 0 12px">${s.frequency === "WEEKLY" ? "Weekly" : "Daily"} report for ${period}. Detailed spreadsheets are attached.</p>
${sections.join("\n")}
<p style="color:#999;font-size:12px;margin-top:24px">Amounts in ₹. You receive this because a report schedule is set up for ${escape(s.email)} in CANAVO.</p>
</div>`;
  const result = await sendMail({ to: s.email, subject, html, attachments });
  await prisma.reportSchedule.update({ where: { id: s.id }, data: { lastSentAt: now } });
  return { ...result, subject, from, to, attachments: attachments.map((a) => a.filename) };
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
