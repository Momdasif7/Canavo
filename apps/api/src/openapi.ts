/**
 * OpenAPI index of the CANAVO API. Request bodies are validated with the zod
 * schemas in @canavo/shared (named in each description).
 */
import { ops as inventoryOps } from "./openapi-inventory";
import { ops as serviceOps } from "./openapi-service";
import { ops as crmOps } from "./openapi-crm";
import { ops as platformOps } from "./openapi-platform";

export type Op = [method: string, path: string, summary: string, tag: string, secured?: boolean];

const ops: Op[] = [
  ["post", "/auth/login", "Email + password login (5 failures → 15 min lock). Body: passwordLoginSchema", "Auth", false],
  ["post", "/auth/otp/request", "Send login OTP to a staff phone. Body: otpRequestSchema", "Auth", false],
  ["post", "/auth/otp/verify", "Verify OTP and start a session. Body: otpVerifySchema", "Auth", false],
  ["post", "/auth/refresh", "Rotate refresh token. Body: refreshSchema", "Auth", false],
  ["post", "/auth/logout", "Revoke the refresh token family", "Auth", false],
  ["get", "/auth/me", "Current user, outlets and permissions", "Auth"],
  ["get", "/outlets", "Outlets visible to the user", "Outlets"],
  ["post", "/outlets", "Create outlet. Body: outletSchema", "Outlets"],
  ["get", "/outlets/current", "Active outlet (X-Outlet-Id)", "Outlets"],
  ["patch", "/outlets/current", "Update outlet settings (outletSchema partial). gstEnabled/invoicePrefix/compositionScheme/pricesIncludeTax need settings:billing; composition requires gstEnabled; response may include warnings[] (e.g. GST on without GSTIN)", "Outlets"],
  ["get", "/outlets/current/shifts", "List shifts", "Outlets"],
  ["post", "/outlets/current/shifts", "Create shift. Body: shiftSchema", "Outlets"],
  ["get", "/staff", "Staff in outlet", "Staff"],
  ["post", "/staff", "Create staff. Body: staffCreateSchema", "Staff"],
  ["patch", "/staff/{id}", "Update staff; role change or deactivation forces logout", "Staff"],
  ["get", "/staff/{id}/performance", "Bills, sales, items sold, attendance %", "Staff"],
  ["post", "/attendance/clock-in", "Clock in with GPS (+PIN). Body: clockSchema", "Attendance"],
  ["post", "/attendance/clock-out", "Clock out. Body: clockSchema", "Attendance"],
  ["get", "/attendance/me/status", "Am I clocked in + recent records", "Attendance"],
  ["get", "/attendance/calendar", "Monthly calendar ?month=YYYY-MM&userId=", "Attendance"],
  ["get", "/attendance", "Outlet attendance ?from&to&userId", "Attendance"],
  ["get", "/attendance/export", "Export ?from&to&format=xlsx|csv", "Attendance"],
  ["get", "/attendance/salary", "Salary sheet ?month=YYYY-MM", "Attendance"],
  ["post", "/attendance/leaves", "Apply for leave. Body: leaveRequestSchema", "Attendance"],
  ["get", "/attendance/leaves", "My leaves, or ?scope=outlet for managers", "Attendance"],
  ["patch", "/attendance/leaves/{id}", "Approve / reject leave", "Attendance"],
  ["get", "/menu", "Full menu with outlet overrides", "Menu"],
  ["post", "/menu/categories", "Create category", "Menu"],
  ["post", "/menu/items", "Create item. Body: menuItemSchema (taxRateId?: string|null; gstRate is kept = cgst+sgst of the rate). Item JSON has taxRateId + taxRate {id, name, cgst, sgst, igst, cess, extras}|null", "Menu"],
  ["patch", "/menu/items/{id}", "Update item", "Menu"],
  ["put", "/menu/items/{id}/override", "Outlet price/status override", "Menu"],
  ["get", "/menu/import/template", "CSV template", "Menu"],
  ["post", "/menu/import", "Bulk import (text/csv); optional taxRate column = tax rate name", "Menu"],
  ["post", "/orders", "Create bill + KOTs. Body: orderCreateSchema", "Billing"],
  ["post", "/orders/sync", "Flush offline bill queue", "Billing"],
  ["get", "/orders", "List bills ?date&status&search", "Billing"],
  ["get", "/orders/{id}", "Bill detail with balance", "Billing"],
  ["post", "/orders/{id}/cancel", "Cancel bill (manager)", "Billing"],
  ["post", "/orders/{id}/payments", "Record cash/card/UPI/khata, split allowed. Body: paymentSchema", "Payments"],
  ["post", "/orders/{id}/upi-qr", "Dynamic UPI QR for balance", "Payments"],
  ["get", "/orders/{id}/payment-status", "Poll payment status", "Payments"],
  ["post", "/orders/{id}/payments/{paymentId}/confirm", "Manually confirm pending UPI", "Payments"],
  ["get", "/orders/{id}/receipt", "Receipt JSON, or ?format=text&paper=58|80", "Receipts"],
  ["get", "/orders/{id}/receipt.pdf", "Receipt PDF", "Receipts"],
  ["post", "/orders/{id}/share/whatsapp", "Share receipt on WhatsApp", "Receipts"],
  ["get", "/public/receipts/{token}", "Public signed receipt PDF", "Receipts", false],
  ["post", "/webhooks/razorpay", "Razorpay qr_code.credited webhook", "Payments", false],
  ["get", "/kot", "Active KOTs ?station", "Kitchen"],
  ["patch", "/kot/{id}", "Update KOT status", "Kitchen"],
  ["post", "/kot/{id}/print", "Print / reprint KOT text", "Kitchen"],
  ["get", "/reports/daily", "Daily summary ?date", "Reports"],
  ["get", "/notifications", "My notifications", "Notifications"],
];

const paths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary, tag, secured = true] of [...ops, ...inventoryOps, ...serviceOps, ...crmOps, ...platformOps]) {
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    tags: [tag],
    ...(secured && { security: [{ bearer: [] }], parameters: [{ $ref: "#/components/parameters/outlet" }] }),
    responses: { "200": { description: "OK" } },
  };
}

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "CANAVO API",
    version: "0.1.0",
    description: "Canteen POS + management. All money values are integer paise (₹1 = 100).",
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    parameters: {
      outlet: { name: "X-Outlet-Id", in: "header", required: false, schema: { type: "string" }, description: "Active outlet" },
    },
  },
  paths,
};
