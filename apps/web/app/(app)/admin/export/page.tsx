"use client";

import { FileArchive, FileCode, LockSimple } from "@phosphor-icons/react";
import { useSession } from "@/components/providers/SessionProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { DownloadButton } from "@/components/reports/ExportButtons";
import { Card, CardHeader } from "@/components/ui/Card";

const INCLUDED = [
  "Outlets and their settings, GST and tax rates",
  "Menu: categories, items, variants and add-ons",
  "Orders, bills, payments, KOTs and refunds",
  "Customers, khata (credit) and loyalty, offers and coupons",
  "Staff accounts and shifts — without passwords, PINs or Aadhaar numbers",
  "Attendance and payroll records",
  "Inventory: stock, purchases, vendors, recipes, audits and transfers",
  "Tables, reservations and deliveries",
];

/** Owner: download all of their own business's data (GET /admin/export). */
export default function ExportDataPage() {
  const { me } = useSession();
  const business = me?.business?.name ?? "your business";
  return (
    <>
      <PageHeader title="Export data" subtitle={`Download a complete copy of ${business}'s data — for your records, accounting tools or moving to another system.`} />
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card className="self-start">
          <CardHeader title="What's included" subtitle="Every outlet of this business. Data of other businesses is never included." />
          <ul className="list-disc space-y-1.5 px-5 pb-5 pl-10 text-sm">
            {INCLUDED.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Card>
        <Card className="self-start">
          <CardHeader title="Download" />
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap gap-2">
              <DownloadButton path="/admin/export" query={{ format: "json" }} filename="canavo-export.json" icon={<FileCode size={20} />} size="md">
                Download JSON
              </DownloadButton>
              <DownloadButton path="/admin/export" query={{ format: "csv-zip" }} filename="canavo-export.zip" icon={<FileArchive size={20} />} size="md">
                Download CSV (zip)
              </DownloadButton>
            </div>
            <p className="text-xs text-muted">JSON is one file with every table; the zip has one CSV per table (opens in Excel). Large businesses can take a minute.</p>
            <p className="flex items-start gap-2 text-xs text-muted">
              <LockSimple size={16} className="mt-px shrink-0" />
              Every export is recorded in the audit log. Keep the file safe — it contains your customers&apos; and staff&apos;s details.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
