import type { Op } from "./openapi";

const fmt = "format=json|xlsx|pdf";

export const ops: Op[] = [
  // Reports (outlet-scoped via X-Outlet-Id, permission report:view)
  ["get", "/reports/sales", `Sales ?from&to&groupBy=day|week|month&${fmt} — gross, net, tax, discounts, promo, charges, AOV, cancellations, by order type & payment mode`, "Reports"],
  ["get", "/reports/items", `Item sales ?from&to&limit&${fmt} — qty, revenue, share, best sellers, slow movers (incl. zero sales)`, "Reports"],
  ["get", "/reports/categories", `Category sales ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/peak-hours", `Weekday × hour heatmap of orders & revenue ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/gst", `GST summary by rate (taxable, CGST, SGST, IGST), document counts, cancelled invoices ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/gstr1", "GSTR-1 (b2cs, hsn, doc_issue) ?month=YYYY-MM&format=json|xlsx|pdf&download=1 (bare GSTN JSON file)", "Reports"],
  ["get", "/reports/profit", `Revenue vs COGS, purchases, wastage, gross margin, per-item food cost % ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/staff", `Bills/sales/cancellations per cashier + attendance & estimated pay ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/customers", `New vs repeat customers, AOV, top customers, loyalty, khata ?from&to&limit&${fmt}`, "Reports"],
  ["get", "/reports/inventory", `Stock movement per item (opening/in/out/closing, wastage) + vendor purchases ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/delivery", `Delivery orders, avg delivery time (assigned→delivered), per agent ?from&to&${fmt}`, "Reports"],
  ["get", "/reports/outlets/overview", `Multi-outlet dashboard ?date&${fmt} (all outlets for super admin; not outlet-scoped)`, "Reports"],
  ["get", "/reports/owner-summary", "Owner home: today so far vs same weekday last week per outlet (sales, voids, refunds, big discounts, cash drawer, unapproved approvals, top items, low stock); not outlet-scoped", "Reports"],

  // Admin
  ["get", "/admin/report-schedules", "Report schedules of the outlet (?all=1 for super admin)", "Admin"],
  ["post", "/admin/report-schedules", "Create schedule. Body: reportScheduleSchema {email, frequency: DAILY|WEEKLY, reports[]}", "Admin"],
  ["delete", "/admin/report-schedules/{id}", "Delete schedule", "Admin"],
  ["post", "/admin/report-schedules/{id}/send-now", "Email the schedule now (SMTP, or storage/outbox when SMTP is not configured)", "Admin"],
  ["get", "/admin/audit-logs", "Audit log ?entity&action(prefix*)&userId&outletId&from&to&page&pageSize (audit:view)", "Admin"],
  ["get", "/admin/settings", "Whitelisted setting keys and defaults", "Admin"],
  ["get", "/admin/settings/{scope}/{key}", "Read a setting; scope = GLOBAL or an outlet id", "Admin"],
  ["put", "/admin/settings/{scope}/{key}", "Write a setting. Body: {value} validated per key (SETTING_SCHEMAS)", "Admin"],
  ["post", "/admin/backups", "Create a gzipped NDJSON backup of all tables (admin:backup)", "Admin"],
  ["get", "/admin/backups", "List backups", "Admin"],
  ["get", "/admin/backups/{file}", "Download a backup file", "Admin"],
  ["post", "/admin/backups/{file}/restore", 'Restore a backup (truncates all tables). Body: {confirm: "RESTORE"}; refuses on migration mismatch', "Admin"],
  ["get", "/admin/table-counts", "Row count per table (verify backups/restores)", "Admin"],
  ["get", "/admin/export", "Full data export ?format=json|csv-zip (super admin; secrets redacted)", "Admin"],
  ["patch", "/admin/staff/{id}/aadhaar", "Store Aadhaar (AES-256-GCM encrypted). Body: {aadhaar}", "Admin"],
  ["get", "/admin/staff/{id}/aadhaar", "Masked Aadhaar, ?reveal=1 for full number (super admin, audited)", "Admin"],

  // Uploads
  ["post", "/uploads/image", "Upload JPEG/PNG/WebP ≤5 MB (multipart field `file` or raw image/* body) → {url}", "Uploads"],
  ["get", "/uploads/files/{name}", "Public: locally stored upload", "Uploads", false],
  ["get", "/uploads/signature", "Cloudinary signed-upload parameters for direct uploads (404 when not configured)", "Uploads"],

  // Tax rates (business-scoped; read: menu:view or settings:billing, write: settings:billing)
  ["get", "/tax-rates", "Tax rates of the business → [{id, name, cgst, sgst, igst, cess, extras:[{label, percent}], isDefault, active, itemCount}]", "Tax"],
  ["get", "/tax-rates/{id}", "One tax rate (with itemCount)", "Tax"],
  ["post", "/tax-rates", "Create. Body: taxRateSchema {name, cgst, sgst, igst? (default cgst+sgst), cess?, extras?:[{label, percent}], isDefault?, active?}; percents 0–100, ≤3 decimals. Returns the rate + optional warnings[] (e.g. CGST ≠ SGST). isDefault unsets the previous default", "Tax"],
  ["patch", "/tax-rates/{id}", "Update (taxRateUpdateSchema, all optional). Re-syncs MenuItem.gstRate of linked items. Returns the rate + optional warnings[]", "Tax"],
  ["delete", "/tax-rates/{id}", "Delete ?reassignTo=<rateId>. 409 {error, details:{itemCount}} when used by menu items (or when it is the default) and no reassignTo; 204 on success", "Tax"],

  // Notifications
  ["post", "/notifications/devices", "Register Expo push token. Body: {token, platform: ios|android|web}", "Notifications"],
  ["delete", "/notifications/devices/{token}", "Unregister push token", "Notifications"],
  ["post", "/notifications/read-all", "Mark all my notifications read", "Notifications"],
];
