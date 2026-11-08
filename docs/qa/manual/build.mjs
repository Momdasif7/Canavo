#!/usr/bin/env node
/**
 * QA Phase 15 — manual testing pack generator.
 *
 *   node docs/qa/manual/build.mjs        (from the repo root; Node 22.6+ for the .ts import)
 *
 * Writes, next to this file:
 *   MANUAL_TEST_CASES.csv   importable (one row per case, Steps / Expected keep their line breaks)
 *   MANUAL_TEST_CASES.xlsx  sheets: Test Cases · Summary (formulas) · Daily Log · Compatibility · Bug Log · Lists
 *   MANUAL_TEST_CASES.md    per-module counts + case index (ID, title line)
 *   COMPATIBILITY_MATRIX.md browsers × OS × screen sizes
 *
 * Sources: role permissions are imported from packages/shared/src/rbac.ts (so the role × page matrix follows
 * the code); page rules are copied from apps/web/components/layout/nav.ts; demo data from apps/api/prisma/seed*.ts.
 * Re-run after changing roles, pages or cases. Do not hand-edit the generated files.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "package.json"));
const ExcelJS = require("exceljs");
const { ROLE_PERMISSIONS } = await import(pathToFileURL(join(root, "packages/shared/src/rbac.ts")).href);

// ---------------------------------------------------------------- demo data
const PW = "Canavo@123";
const ROLE = {
  OWN: { label: "Owner", key: "BUSINESS_OWNER", email: "owner@canavo.local", name: "Omkar Owner" },
  MGR: { label: "Manager", key: "OUTLET_MANAGER", email: "manager@canavo.local", name: "Manoj Manager" },
  CSH: { label: "Cashier", key: "CASHIER", email: "cashier@canavo.local", name: "Kavya Cashier" },
  KIT: { label: "Kitchen", key: "KITCHEN", email: "kitchen@canavo.local", name: "Ravi Cook" },
  INV: { label: "Inventory", key: "INVENTORY_MANAGER", email: "inventory@canavo.local", name: "Isha Inventory" },
  DEL: { label: "Delivery partner", key: "DELIVERY", email: "delivery@canavo.local", name: "Deepak Delivery" },
  WTR: { label: "Waiter", key: "WAITER", email: "waiter@canavo.local", name: "Wasim Waiter" },
  ACC: { label: "Accountant", key: "ACCOUNTANT", email: "accountant@canavo.local", name: "Anita Accountant" },
  AUD: { label: "Auditor", key: "AUDITOR", email: "auditor@canavo.local", name: "Arjun Auditor" },
  SA: { label: "Super Admin", key: "SUPER_ADMIN", email: "admin@canavo.local", name: "Asha Admin" },
  SUP: { label: "Platform support", key: "PLATFORM_SUPPORT", email: "support@canavo.local", name: "Sana Support" },
  GST: { label: "Guest (customer, no login)" },
  ANY: { label: "Any staff role" },
};
const login = (r) => `Logged in on the web app as ${ROLE[r].email} / ${PW} (outlet "CANAVO Canteen").`;
const DEMO = 'Demo Hotel → outlet "CANAVO Canteen" (Bengaluru, GSTIN 29ABCDE1234F1ZW, prices include 5 % GST, UPI canavo@okaxis).';

// ---------------------------------------------------------------- cases
const cases = [];
const counters = {};
/** c(module, role, priority, type, preconditions, test data, steps[], expected, rtm) */
function c(mod, role, prio, type, pre, data, steps, expected, rtm = "") {
  const code = MOD[mod];
  if (!code) throw new Error(`Unknown module ${mod}`);
  counters[code] = (counters[code] ?? 0) + 1;
  cases.push({
    id: `TC-${code}-${String(counters[code]).padStart(3, "0")}`,
    module: mod,
    role: ROLE[role]?.label ?? role,
    priority: prio,
    type,
    pre: pre === "L" ? login(role) : pre.replace(/^L:/, `${login(role)} `),
    data,
    steps: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    expected,
    rtm,
  });
}
const MOD = {
  "Access & roles": "RBAC", Auth: "AUTH", "POS billing": "POS", Payments: "PAY", "Bills & refunds": "BILL",
  Kitchen: "KOT", Tables: "TAB", "Online ordering": "ONL", "QR table ordering": "QRT", "Delivery (manager)": "DLM",
  "Delivery address mode": "DAM", "Delivery partner": "DLP", Inventory: "INV", "Menu & bulk upload": "MENU",
  "Customers & khata": "CUS", "DPDP & consent": "DPDP", Offers: "OFR", Attendance: "ATT", Staff: "STF",
  "Reports & GST": "REP", "Settings & taxes": "SET", Integrations: "INT", "WhatsApp templates": "WA",
  Appearance: "APP", "Cinema seat ordering": "CIN", Canteen: "CNT", "Cash drawer & gift cards": "CSH",
  Reservations: "RES", Platform: "PLAT", "Admin, audit & export": "ADM", "Mobile app": "MOB", "Offline & resilience": "OFF",
  Notifications: "NOT", Localization: "L10N", "UI & usability": "UI",
};

// ---- Auth
c("Auth", "OWN", "P1", "functional", "App open at the login page. " + DEMO, `owner@canavo.local / ${PW}`,
  ["Type the email and password.", "Click Sign in."], "Dashboard opens; your name \"Omkar Owner\" shows in the top bar; sidebar shows Dashboard, Billing & orders, Kitchen, Settings, Admin and the other groups.", "AUTH-01");
c("Auth", "CSH", "P1", "functional", "Login page open.", `cashier@canavo.local / ${PW}`,
  ["Sign in."], "The POS screen opens directly (cashiers land on POS, not the dashboard).", "AUTH-01");
c("Auth", "KIT", "P2", "functional", "Login page open.", `kitchen@canavo.local / ${PW}`, ["Sign in."], "Kitchen display opens directly.", "AUTH-01");
c("Auth", "DEL", "P2", "functional", "Login page open.", `delivery@canavo.local / ${PW}`, ["Sign in."], "\"My deliveries\" (partner portal) opens; no Bills, Settings or POS in the menu.", "AUTH-01");
c("Auth", "WTR", "P2", "functional", "Login page open.", `waiter@canavo.local / ${PW}`, ["Sign in."], "Tables (floor plan) opens directly; POS is not in the menu.", "AUTH-01");
c("Auth", "INV", "P2", "functional", "Login page open.", `inventory@canavo.local / ${PW}`, ["Sign in."], "Inventory → Stock opens directly.", "AUTH-01");
c("Auth", "SA", "P1", "functional", "Login page open.", `admin@canavo.local / ${PW}`, ["Sign in."], "Platform console (Overview) opens; there is no POS, Bills, Customers or Reports for any hotel.", "RBAC-05");
c("Auth", "ANY", "P1", "negative", "Login page open.", "cashier@canavo.local / Wrong@123", ["Enter the wrong password.", "Click Sign in."], "Error \"Invalid email or password\" (or similar) shown; you stay on the login page; the message does not say which of the two was wrong.", "AUTH-01");
c("Auth", "ANY", "P2", "negative", "Login page open.", "nobody@canavo.local / Canavo@123", ["Sign in with an email that does not exist."], "Same generic error as a wrong password (no \"user not found\").", "AUTH-01");
c("Auth", "ANY", "P1", "negative", "Login page open.", "cashier@canavo.local, wrong password 10 times", ["Enter a wrong password 10 times in a row within a few minutes.", "Then enter the correct password."], "After several failures login is temporarily blocked with a \"too many attempts\" message; correct password also refused until the wait ends.", "AUTH-07");
c("Auth", "ANY", "P2", "boundary", "Login page open.", "Email with spaces: \"  cashier@canavo.local  \" / Canavo@123", ["Paste the email with leading/trailing spaces.", "Sign in."], "Login works (spaces trimmed) or a clear validation message — never a crash.", "AUTH-01");
c("Auth", "ANY", "P2", "functional", "L:", "—", ["Click your name / avatar → Log out.", "Press the browser Back button."], "Login page shown; Back does not show the previous screen's data; you must sign in again.", "AUTH-04");
c("Auth", "CSH", "P2", "functional", "Login page; phone OTP login enabled (dev shows the code on screen / in the API log).", "Phone 9876500002", ["Choose \"Login with phone\".", "Enter 9876500002, request the OTP.", "Enter the OTP."], "Signed in as Kavya Cashier; POS opens.", "AUTH-02");
c("Auth", "CSH", "P2", "negative", "OTP requested for 9876500002.", "OTP 000000", ["Enter a wrong 6-digit OTP.", "Enter the correct OTP twice (second time after a successful login)."], "Wrong OTP refused; a used OTP cannot be used again.", "AUTH-02");
c("Auth", "OWN", "P1", "functional", "Two browsers: A logged in as cashier; B logged in as owner.", "Staff: Kavya Cashier", ["In B: Staff → Kavya Cashier → reset password (or change role).", "In A: click anywhere / refresh."], "Browser A is signed out and returned to login within a minute.", "AUTH-05");
c("Auth", "ANY", "P2", "functional", "Login page.", "cashier@canavo.local", ["Click \"Forgot password\".", "Enter the email and submit."], "Neutral message \"If the account exists we sent a link\"; (dev) link appears in the email outbox; link opens a reset page; new password works once.", "AUTH-04");
c("Auth", "ANY", "P3", "UI", "Login page on a phone (390 px wide).", "—", ["Look at the login page.", "Toggle the password eye icon."], "Fields fit without side-scroll; password show/hide works; keyboard does not hide the Sign in button.", "UI-01");

// ---- POS billing
const posPre = "L:POS open, no cart. Time between 11:30 and 15:00 (so happy hour does not apply).";
c("POS billing", "CSH", "P1", "functional", posPre, "Masala Chai (Regular ₹15) × 2, Samosa (2 pcs) ₹30 × 1", ["Tap Masala Chai, choose Regular, tap again for qty 2.", "Tap Samosa (2 pcs).", "Check the cart total.", "Tap Pay → Cash → enter 100 → Confirm."], "Total ₹60 (prices include GST; tax shown inside). Change to return ₹40. Bill number INV/… shown; receipt preview opens; cart clears.", "BILL-01");
c("POS billing", "CSH", "P1", "functional", posPre, "5 items: Veg Thali ₹110, Mango Lassi ₹50, Gulab Jamun ₹35, Filter Coffee Large ₹30, Mineral Water ₹20", ["Add all 5 items.", "Pay by UPI (mark received)."], "Total ₹245. Mineral Water taxed at 18 % (HSN 2201), others 5 %; receipt shows rate-wise CGST/SGST split; amounts add up exactly.", "BILL-01");
c("POS billing", "CSH", "P1", "functional", posPre, "Chicken Biryani Full ₹260 + Extra cheese add-on on Vada Pav ₹25+₹20", ["Add Chicken Biryani, pick size Full.", "Add Vada Pav with add-on Extra cheese.", "Pay cash."], "Biryani line ₹260 with \"Full\"; Vada Pav line ₹45 with \"+ Extra cheese\"; total ₹305; non-veg mark shown on the biryani.", "MENU-02");
c("POS billing", "CSH", "P1", "functional", posPre, "Veg Sandwich ×1", ["Add Veg Sandwich.", "Use − to reduce to 0 (or tap remove)."], "Line disappears; total ₹0; Pay is disabled.", "BILL-01");
c("POS billing", "CSH", "P2", "boundary", posPre, "Masala Chai qty 999", ["Add Masala Chai.", "Type quantity 999 in the qty field."], "Accepted or capped with a clear message; total ₹14,985 shown in Indian grouping (₹14,985); no layout break.", "BILL-01");
c("POS billing", "CSH", "P2", "negative", posPre, "Qty -1, 0, 1.5, \"abc\"", ["Try to type each value into the quantity field."], "Negative, zero, text refused; fractional only for items sold by weight; total never negative.", "BILL-01");
c("POS billing", "CSH", "P1", "functional", posPre, "Takeaway / Dine-in / Delivery", ["Add Samosa.", "Switch order type between Takeaway, Dine-in (choose table T1) and Delivery (enter customer)."], "Order type changes; Dine-in asks for a table; Delivery asks for customer phone + address; service charge (if set) only on dine-in.", "BILL-09");
c("POS billing", "CSH", "P1", "functional", posPre, "Item search \"pav\"", ["Type \"pav\" in the menu search."], "Only Vada Pav shows; clearing the search restores all items; category tabs still work.", "UI-01");
c("POS billing", "CSH", "P2", "functional", "L:POS open between 07:00 and 11:30.", "Masala Dosa (breakfast only 07:00–11:30)", ["Find Masala Dosa.", "Repeat after 11:30."], "Before 11:30 it can be added; after 11:30 it shows unavailable / hidden (time-window item).", "MENU-02");
c("POS billing", "CSH", "P1", "functional", posPre, "Paneer Butter Masala + 2 Roti ×4 (₹520) + Mango Lassi ×2 (₹100) = ₹620", ["Add the items.", "Look at the offers line before paying."], "\"10% off bills over ₹500\" applied: −₹62 (cap ₹100). Only one offer on the bill.", "OFR-02");
c("POS billing", "CSH", "P1", "functional", posPre, "Manual discount 10 %", ["Add Veg Thali ₹110.", "Tap Discount → 10 % → reason \"Regular customer\"."], "Discount ₹11 shown; tax recalculated on the reduced value; large discounts above the limit ask for a manager PIN.", "BILL-05");
c("POS billing", "CSH", "P1", "negative", posPre, "Manual discount 60 %", ["Add Veg Thali.", "Try a 60 % discount."], "Manager approval PIN requested; wrong PIN refused; manager PIN (manager@ staff PIN 1234) approves and the approval is logged.", "BILL-05");
c("POS billing", "CSH", "P2", "boundary", posPre, "Manual discount 100 % and ₹200 on a ₹110 bill", ["Try a flat ₹200 discount on Veg Thali."], "Refused or capped at the bill value; total never below ₹0.", "BILL-05");
c("POS billing", "CSH", "P1", "functional", posPre, "Customer phone 9845010001 (Priya Sharma, Platinum, 1820 points)", ["Add Cold Coffee ₹60.", "Attach customer by phone.", "Pay cash."], "Customer name and tier shown on the bill; loyalty points earned shown on the receipt; customer visit count +1.", "CUS-01");
c("POS billing", "CSH", "P2", "functional", posPre, "Kitchen note \"less sugar\"", ["Add Masala Chai.", "Add the note \"less sugar\" to the line.", "Send / pay."], "The KOT on the kitchen display shows \"less sugar\" under Masala Chai.", "KOT-01");
c("POS billing", "CSH", "P1", "functional", posPre, "Masala Chai + Veg Fried Rice", ["Add a beverage and a meal.", "Pay."], "Two KOTs created: one for the BEVERAGE station (chai), one for the main kitchen (fried rice).", "KOT-01");
c("POS billing", "CSH", "P2", "functional", posPre, "Hold bill", ["Add 3 items.", "Tap Hold / Park.", "Start a new bill, then resume the held one."], "Held cart restored exactly (items, qty, notes).", "BILL-01");
c("POS billing", "CSH", "P2", "functional", posPre, "Rounding: Badam Milk ₹35 × 1 with prices excl. tax (owner switches setting in a test outlet)", ["Owner sets prices to exclude tax.", "Cashier bills Badam Milk."], "₹35 + 5 % = ₹36.75 → round-off line −₹0.75 / +₹0.25 to nearest rupee; payable ₹37.", "BILL-07");
c("POS billing", "CSH", "P1", "functional", posPre, "Receipt", ["Complete any bill.", "Open the receipt / print preview."], "Shows outlet name, address, GSTIN 29ABCDE1234F1ZW, FSSAI 11224999000123, invoice no., IST date/time, HSN/SAC, place of supply \"29-Karnataka\", CGST+SGST split, total in ₹ with Indian grouping.", "CMP-01");
c("POS billing", "CSH", "P2", "UI", "POS open on a 1024×768 touchscreen or tablet.", "—", ["Bill 5 items using touch only."], "Buttons large enough to tap; cart and Pay always visible; no hover-only controls.", "UI-01");
c("POS billing", "CSH", "P2", "functional", posPre, "Delivery order at POS (map mode)", ["Choose Delivery.", "Phone 9845010002, address 12 MG Road, pick on map inside zone.", "Pay COD."], "Delivery fee from the zone added as a line; order appears on the Delivery board as unassigned/assigned.", "DEL-01");
c("POS billing", "WTR", "P1", "negative", "L", "URL /pos", ["Type /pos into the address bar."], "\"This page isn't available for your role\" shown; waiter cannot take payment.", "RBAC-02");
c("POS billing", "CSH", "P2", "functional", posPre, "Keyboard: search, Enter, Esc", ["Use only the keyboard: focus search, type \"chai\", Enter to add, open Pay, Esc to close."], "All actions reachable with keyboard; visible focus ring; Esc closes dialogs.", "UI-01");

// ---- Payments
c("Payments", "CSH", "P1", "functional", "L:Store has no Razorpay keys (Settings → Integrations shows \"Not connected\").", "Samosa ₹30, UPI", ["Bill Samosa.", "Choose UPI."], "Plain UPI QR for canavo@okaxis with ₹30 shown; cashier must tap \"Received\" to close the bill.", "BILL-10");
c("Payments", "CSH", "P1", "functional", "Store has Razorpay TEST keys saved; webhook configured (see PAYMENT_CHECKLIST).", "Veg Thali ₹110, UPI", ["Bill Veg Thali → UPI.", "Scan the QR with a UPI app in Razorpay test mode (or simulate success in the Razorpay dashboard)."], "Bill marks paid automatically within ~10 s after the webhook; no manual tap needed.", "SEC-05");
c("Payments", "CSH", "P1", "functional", posPre, "Split: ₹245 = Cash ₹100 + UPI ₹145", ["Bill ₹245.", "Pay → Split → Cash 100, UPI 145."], "Bill paid; Bills shows two payments that sum to ₹245.", "BILL-10");
c("Payments", "CSH", "P1", "negative", posPre, "Split: Cash ₹100 + UPI ₹100 on ₹245", ["Try to confirm a split that is short by ₹45."], "Cannot confirm; remaining ₹45 shown.", "BILL-10");
c("Payments", "CSH", "P2", "boundary", posPre, "Cash tendered ₹2000 on ₹30", ["Pay ₹30 with cash 2000."], "Change ₹1,970 shown in Indian format; only cash may be over-tendered (UPI/card exact).", "BILL-10");
c("Payments", "CSH", "P1", "functional", posPre, "Khata: Vikram Rao 9845010004 (balance ₹640, limit ₹2,000)", ["Bill ₹110 to Vikram.", "Pay by Khata."], "Khata balance becomes ₹750; bill shows payment mode Khata.", "CUS-02");
c("Payments", "CSH", "P1", "negative", posPre, "Khata: Arjun Nair 9845010006 (balance ₹1,250, limit ₹1,500)", ["Bill ₹300 to Arjun.", "Pay by Khata."], "Refused: over khata limit (₹1,550 > ₹1,500); manager may override with PIN if allowed.", "CUS-02");
c("Payments", "CSH", "P2", "negative", posPre, "Blocked customer Sanjay Gupta 9845010012", ["Attach Sanjay and try Khata."], "Khata not allowed for a blocked customer; cash/UPI still allowed.", "CUS-02");
c("Payments", "CSH", "P2", "functional", "Razorpay TEST keys; UPI bill pending.", "Close the QR dialog before paying", ["Start UPI on ₹50.", "Close the dialog without paying.", "Open Bills."], "Bill shows Pending/Unpaid; can reopen the QR from the bill; no duplicate bill.", "BILL-10");
c("Payments", "CSH", "P2", "functional", "Razorpay TEST keys.", "Card payment", ["Bill ₹90, pay Card, enter last 4 digits/ref if asked."], "Bill paid with mode Card; shows in day-end card total.", "BILL-10");
c("Payments", "OWN", "P1", "functional", "Paid UPI bill via Razorpay test, store keys set.", "Refund ₹50 of a ₹110 bill", ["Bills → open the bill → Refund ₹50, reason \"Wrong item\"."], "Credit note CN… created; Razorpay test dashboard shows refund; bill shows refund status (processed after webhook).", "BILL-12");

// ---- Bills & refunds
c("Bills & refunds", "CSH", "P1", "functional", "L:At least 3 bills today.", "—", ["Open Bills.", "Filter Today, payment mode UPI."], "Only today's UPI bills; totals match the list; newest first.", "BILL-15");
c("Bills & refunds", "CSH", "P1", "functional", "L:A paid bill with items still in the kitchen.", "Bill with Veg Fried Rice", ["Open Bills → click the bill.", "Look at the Kitchen status section."], "Each item shows its ticket status (Received / Preparing / Ready / Served) with times; updates live when the kitchen bumps it.", "KOT-02");
c("Bills & refunds", "KIT", "P2", "functional", "Cashier has the bill drawer open (other browser).", "Same bill", ["Kitchen: mark the KOT Preparing, then Ready.", "Cashier: watch the drawer without refreshing."], "Cashier sees \"Preparing\" then \"Ready\" with times within a few seconds.", "KOT-03");
c("Bills & refunds", "CSH", "P1", "negative", "L:A paid bill.", "Cancel bill", ["Open the bill → Cancel."], "Cashier cannot cancel without manager approval (PIN); reason required.", "BILL-12");
c("Bills & refunds", "MGR", "P1", "functional", "L:A paid cash bill ₹60.", "Reason \"Customer left\"", ["Open the bill → Cancel → reason → confirm."], "Bill status Cancelled; credit note number CN…; stock restored; khata/points reversed; appears in audit log.", "BILL-12");
c("Bills & refunds", "MGR", "P2", "functional", "L:Paid bill.", "Reprint", ["Open the bill → Print / Reprint."], "Receipt prints with \"DUPLICATE\"/reprint mark.", "BILL-13");
c("Bills & refunds", "CSH", "P2", "functional", "L:Paid bill; customer phone attached.", "Share receipt", ["Open the bill → Share on WhatsApp / copy link.", "Open the link in a private window."], "Public receipt page loads without login; shows the same totals; changing one character of the link shows \"not found\".", "BILL-13");
c("Bills & refunds", "ACC", "P2", "functional", "L", "—", ["Open Bills, open any bill."], "Accountant can view and download; no Cancel / Refund buttons.", "BILL-15");
c("Bills & refunds", "AUD", "P2", "negative", "L", "—", ["Open Bills → any bill."], "Read-only; no cancel, refund, reprint-with-change actions.", "RBAC-02");
c("Bills & refunds", "MGR", "P2", "boundary", "L:Bill paid ₹110.", "Refund ₹111", ["Try to refund more than the bill."], "Refused; maximum refundable shown.", "BILL-12");

// ---- Kitchen
c("Kitchen", "KIT", "P1", "functional", "L:Kitchen display open; cashier bills Veg Fried Rice.", "—", ["Watch the KDS.", "Tap the ticket → Start (Preparing) → Ready."], "Ticket appears within 3 s with a sound; moves through Preparing and Ready; cashier gets an \"order ready\" notification.", "KOT-02");
c("Kitchen", "KIT", "P1", "functional", "L:KDS open.", "Wi-Fi off 30 s", ["Turn Wi-Fi off for 30 s while the cashier bills 2 orders.", "Turn Wi-Fi on."], "\"Offline\" indicator while disconnected; both tickets appear after reconnect without manual refresh (resync within 15 s).", "KOT-03");
c("Kitchen", "KIT", "P2", "functional", "L:KDS with tickets from 2 stations.", "Station filter", ["Filter by BEVERAGE."], "Only beverage tickets shown.", "KOT-01");
c("Kitchen", "KIT", "P2", "negative", "L", "URL /menu, /bills, /reports", ["Type each URL."], "Not available for your role on each.", "RBAC-02");
c("Kitchen", "KIT", "P2", "UI", "KDS on a wall TV (1920×1080) from 3 m away.", "10 open tickets", ["Look at the board."], "Item names and table/token readable; old tickets highlighted by age colour.", "UI-01");
c("Kitchen", "KIT", "P2", "functional", "L:Printer configured for KOT.", "KOT reprint", ["Open a ticket → Reprint."], "KOT prints marked REPRINT; KOT paper width follows the KOT printer setting (58/80 mm).", "KOT-04");
c("Kitchen", "KIT", "P3", "functional", "L:Cinema seat order placed (see CIN cases).", "Seat order", ["Look at the KOT."], "Black seat bar \"S1 · G5\" with badge INTERVAL / COUNTER #n / TO SEAT NOW.", "");

// ---- Tables
c("Tables", "WTR", "P1", "functional", "L:Floor plan: Main Hall T1–T8, Terrace P1–P4.", "Table T3, 2× Masala Chai, 1× Onion Pakoda", ["Tap T3 → Open tab, 2 guests.", "Add the items → Send to kitchen."], "T3 turns occupied; KOT sent; tab total ₹70; waiter sees no Pay button.", "TAB-01");
c("Tables", "WTR", "P2", "functional", "L:T3 has an open tab.", "Add 1× Gulab Jamun", ["Open T3 → add item → Send."], "Only the new item goes as a new KOT (old items not re-sent).", "KOT-01");
c("Tables", "CSH", "P1", "functional", "L:T3 tab ₹105.", "Bill full", ["Open T3 → Bill → pay cash."], "Table becomes free; bill number generated; tab closed.", "TAB-02");
c("Tables", "CSH", "P1", "functional", "L:T5 tab with 4 items ₹300.", "Split equally in 2", ["Open T5 → Split → 2 ways.", "Pay first half UPI, second cash."], "Two bills of ₹150; table frees only after the last bill is paid.", "TAB-02");
c("Tables", "CSH", "P2", "functional", "L:T2 tab.", "Move T2 → P1", ["Open T2 → Move table → P1."], "Tab now on P1; T2 free; KOTs keep the new table label.", "TAB-01");
c("Tables", "MGR", "P2", "functional", "L", "New table T9, 4 seats", ["Tables → edit floor plan → add T9."], "T9 visible to waiters immediately.", "TAB-01");
c("Tables", "WTR", "P2", "functional", "L", "Table QR codes", ["Tables → QR codes.", "Click \"← Tables\" back link."], "QR sheet for each table; back link returns to Tables.", "");
c("Tables", "WTR", "P2", "negative", "Two waiters on two devices open T4.", "Both add items at the same time", ["Waiter A adds Samosa, Waiter B adds Kulfi, both Send."], "Both items on the tab; no item lost; no duplicate KOT.", "TAB-02");

// ---- Online ordering (storefront)
const onl = "Owner has turned on Online ordering (Settings → QR & online ordering) for CANAVO Canteen; open the link from the Share kit (\"Copy link\") on a phone in a private window.";
c("Online ordering", "GST", "P1", "functional", onl, "—", ["Open the link.", "Look at the top band."], "Logo, outlet name, address, Open now/Closed pill with hours, Pickup/Delivery toggle, chips (ETA, delivery fee, min order) and an offers strip with live offers.", "");
c("Online ordering", "GST", "P1", "functional", onl, "Veg only on", ["Turn on Veg only."], "Chicken Biryani, Chicken Puff and Egg Puff disappear; switching off brings them back.", "");
c("Online ordering", "GST", "P2", "functional", onl, "Scroll", ["Scroll down through categories."], "Category tabs stay at the top and the active tab follows the scroll.", "");
c("Online ordering", "GST", "P2", "functional", onl, "Search \"zzz\"", ["Search for zzz."], "\"No dishes match · Clear filters\"; Clear restores the menu.", "");
c("Online ordering", "GST", "P1", "functional", onl, "Vada Pav", ["Tap ADD on Vada Pav.", "Tap + twice."], "ADD becomes − 3 +; floating bar \"3 ITEMS ADDED · ₹75 — View cart ›\".", "");
c("Online ordering", "GST", "P1", "functional", onl, "Chicken Biryani (sizes)", ["Tap ADD on Chicken Biryani.", "Pick Full, tick no add-on, tap Add item."], "Bottom sheet requires a size; button shows \"Add item · ₹260\"; cart shows Full.", "");
c("Online ordering", "GST", "P1", "functional", onl + " Pickup.", "Name Ravi Kumar, phone 9845099001", ["Add 2 items → View cart → Next.", "Enter name and phone (OTP if asked).", "Payment: Pay at counter → Place order."], "Order placed screen with a live tracker (placed → accepted → preparing → ready); order appears in staff \"Online orders\" with a sound.", "");
c("Online ordering", "CSH", "P1", "functional", "L:A new online order is waiting.", "—", ["Open Online orders.", "Accept → mark Ready → hand over."], "Customer tracker moves to accepted, preparing, ready (refresh not needed); KOT printed / shown.", "");
c("Online ordering", "GST", "P1", "negative", onl + " Outlet minimum order ₹150 for delivery.", "Delivery, cart ₹75", ["Switch to Delivery, add ₹75 of items, try checkout."], "Blocking message shows the shortfall (\"Add ₹75 more\"); cannot place order.", "");
c("Online ordering", "GST", "P2", "functional", onl + " Store closed (outside hours).", "—", ["Open the page."], "Red Closed pill and \"we take orders HH:MM–HH:MM\"; ADD buttons say Ordering closed.", "");
c("Online ordering", "GST", "P2", "functional", onl + " Manager marked Kulfi out of stock.", "Kulfi", ["Find Kulfi."], "Greyed out with SOLD OUT chip; cannot add.", "");
c("Online ordering", "GST", "P2", "UI", onl, "Desktop 1366×900", ["Open on a laptop."], "Two panes: menu left, sticky cart right; floating cart bar hidden.", "");
c("Online ordering", "GST", "P2", "functional", onl, "Reload with items in cart", ["Add 2 items.", "Reload the page."], "Cart is kept (saved on the phone).", "");
c("Online ordering", "GST", "P1", "functional", onl + " Razorpay TEST keys set.", "Pay by UPI", ["Place an order choosing UPI.", "Pay in test mode."], "Order placed screen turns paid; staff sees \"UPI prepaid\".", "");
c("Online ordering", "GST", "P2", "negative", onl + " OTP required.", "Wrong OTP 111111", ["Enter a wrong OTP 3 times."], "Refused each time; after limit, wait message; no order created.", "AUTH-02");
c("Online ordering", "GST", "P2", "functional", onl, "Bestsellers", ["Look for \"Recommended\" and ★ Bestseller badges."], "Shown only for items with ≥5 sold in last 30 days (may be empty on a fresh database).", "");
c("Online ordering", "GST", "P3", "boundary", onl, "Cooking note 300 characters with emoji and Hindi \"कम तीखा\"", ["Add a long note to an item and the order."], "Accepted (or trimmed with a counter); prints on the KOT as plain text.", "");
c("Online ordering", "OWN", "P2", "functional", "L", "Share kit", ["Settings → QR & online ordering → Share kit → Copy link."], "Only one copy button (\"Copy link\"); link copied; WhatsApp share button opens a message.", "");

// ---- QR table ordering
c("QR table ordering", "GST", "P1", "functional", "QR table ordering on; print Tables → QR codes; scan the T1 code with a phone.", "2× Masala Chai", ["Scan T1 QR.", "Add items → Place order."], "Order lands on T1's tab and the KDS; page shows status pills.", "");
c("QR table ordering", "GST", "P2", "functional", "On the T1 QR page.", "—", ["Tap Call waiter.", "Tap Ask for bill."], "Staff see a notification for T1 each time.", "NOT-01");
c("QR table ordering", "GST", "P2", "negative", "Owner rotates the T1 QR.", "Old QR photo", ["Scan the old code."], "Page says the code is no longer valid; no order possible.", "");

// ---- Delivery (manager)
c("Delivery (manager)", "MGR", "P1", "functional", "L:Deepak Delivery is clocked in and at the outlet.", "Cashier creates a delivery order", ["Open Delivery board."], "Order auto-assigned to Deepak; card shows customer, address, COD amount.", "DEL-01");
c("Delivery (manager)", "MGR", "P1", "functional", "L:Limit 2 per partner; Deepak already has 2 runs.", "3rd order", ["Create a third delivery order."], "Goes to Waiting queue; managers notified; auto-assigned when Deepak returns.", "DEL-02");
c("Delivery (manager)", "CSH", "P1", "negative", "L:Deepak at limit.", "Manual assign", ["Try to assign the 3rd order to Deepak."], "Refused (partner at limit); manager can force with a warning.", "DEL-05");
c("Delivery (manager)", "MGR", "P2", "functional", "L", "Zones", ["Delivery → Zones & settings → add zone 0–3 km fee ₹30."], "Saved; POS delivery quote uses ₹30 inside 3 km.", "DEL-01");
c("Delivery (manager)", "MGR", "P2", "functional", "L:Partner returned with COD cash ₹420.", "Cash handover", ["Delivery partners → Deepak → receive cash ₹420."], "Partner's COD balance becomes ₹0; recorded with time and manager name.", "DEL-06");
c("Delivery (manager)", "OWN", "P2", "functional", "L", "Live map", ["Open the board while the partner moves (mobile app)."], "Live dot moves; \"back at outlet\" shown when within geofence.", "DEL-03");

// ---- Delivery address mode
const dam = "L:Delivery → Zones & settings → Delivery address = Address only (no map); flat fee ₹30, minimum order ₹150, time 35 min, areas: 560034, 560095, Koramangala, HSR Layout. Saved.";
c("Delivery address mode", "OWN", "P1", "functional", "L", "Fee 30, min 150, ETA 35, areas \"560034, Koramangala\" (press Enter after each)", ["Delivery → Zones & settings.", "Choose Address only (no map), fill the fields, Save."], "Saved message; areas show as chips; audit log has \"delivery.settings\".", "");
c("Delivery address mode", "GST", "P1", "functional", dam + " Open the online page.", "—", ["Switch to Delivery."], "Chips show \"₹30 delivery · 35 min · Min order ₹150\"; no map and no location prompt.", "");
c("Delivery address mode", "GST", "P1", "functional", dam, "Address: 4th Cross, Koramangala 4th Block; landmark Forum Mall; PIN 560034", ["Online page → Delivery → add ₹160 of items → checkout.", "Type the address and PIN."], "\"We deliver here\"; bill has Delivery fee ₹30; order placed; staff board card shows address \"· PIN 560034\" and Open in Google Maps.", "");
c("Delivery address mode", "GST", "P1", "negative", dam, "PIN 560001", ["Enter PIN 560001 at checkout."], "Refusal: \"Sorry, we don't deliver to PIN code 560001 — we deliver to 560034, 560095, Koramangala, HSR Layout\"; Place order disabled.", "");
c("Delivery address mode", "GST", "P2", "boundary", dam, "PIN 56003, 5600345, ABCDEF", ["Enter each invalid PIN."], "\"Enter a 6-digit PIN code\"; no quote shown.", "");
c("Delivery address mode", "GST", "P2", "functional", dam, "Area name match: address \"HSR Layout Sector 2\", PIN 560102 (not listed)", ["Type the address with the listed area name."], "Accepted because the area name matches whole words; \"HSRLayout\" (no space) or \"Kormangala\" (typo) is refused.", "");
c("Delivery address mode", "GST", "P1", "negative", dam, "Cart ₹100, PIN 560034", ["Try to checkout."], "Minimum order message (₹50 short); nothing created.", "");
c("Delivery address mode", "CSH", "P1", "functional", dam, "POS delivery, phone 9845010003, PIN 560095", ["POS → Delivery.", "Enter address and PIN."], "PIN field instead of map/zone; chip \"PIN 560095 · we deliver · Fee ₹30 · ~35 min\"; bill has ₹30 fee line.", "");
c("Delivery address mode", "CSH", "P2", "negative", dam, "POS delivery without PIN", ["Try to save a delivery order with no PIN."], "Refused: PIN code required.", "");
c("Delivery address mode", "DEL", "P1", "functional", dam + " A delivery assigned to Deepak.", "—", ["Open My deliveries.", "Tap Navigate / Open in Google Maps."], "Shows PIN; Google Maps opens searching address + landmark + PIN.", "");
c("Delivery address mode", "MGR", "P2", "functional", dam, "Switch back to Map pin", ["Change the setting back to Map pin, Save.", "Open the online page."], "Map/zones behaviour returns; old zones unchanged.", "");
c("Delivery address mode", "WTR", "P2", "negative", "L", "URL /delivery", ["Open /delivery."], "Not available for your role.", "RBAC-02");
c("Delivery address mode", "OWN", "P2", "boundary", "L", "Fee ₹10,001; min order ₹1,00,001; ETA 4 and 301", ["Try each value and Save."], "Each refused with the allowed range (fee 0–₹10,000; min 0–₹1,00,000; ETA 5–300 min).", "");

// ---- Delivery partner
c("Delivery partner", "DEL", "P1", "functional", "L:Partner app or web; at the outlet.", "Staff PIN 1234", ["Clock in (PIN 1234)."], "On duty; becomes available for auto-assign.", "ATT-01");
c("Delivery partner", "DEL", "P1", "functional", "L:Assigned delivery with COD ₹245.", "—", ["Open the delivery → Picked up → Delivered → collect cash ₹245."], "Status updates on the board and customer tracker; COD balance ₹245 shown in Cash handover.", "DEL-06");
c("Delivery partner", "DEL", "P1", "negative", "L", "Another partner's delivery id in URL", ["Copy a delivery link of another partner (from manager) and open it."], "Not found / not allowed; only own deliveries visible.", "DEL-07");
c("Delivery partner", "DEL", "P2", "functional", "L", "History, Dashboard", ["Open History and Dashboard."], "Only own completed runs, own earnings/COD totals.", "DEL-07");
c("Delivery partner", "DEL", "P2", "negative", "L", "/bills, /settings, /pos", ["Type each URL."], "Not available for your role.", "RBAC-02");
c("Delivery partner", "DEL", "P2", "functional", "Mobile app; partner on a run 2 km away.", "Clock out", ["Clock out away from the outlet."], "Allowed (partners may clock out anywhere).", "ATT-01");

// ---- Inventory
c("Inventory", "INV", "P1", "functional", "L", "Milk (toned) opening 40 L", ["Inventory → Stock → search Milk."], "Milk 40 L (or current), reorder level 10 L, SKU DAI-MILK.", "INV-02");
c("Inventory", "INV", "P1", "functional", "L:Masala Chai recipe uses milk + tea powder.", "Cashier bills 10 Masala Chai", ["Note milk stock.", "After the sale, refresh Stock."], "Milk and tea powder reduced by recipe × 10.", "INV-01");
c("Inventory", "INV", "P1", "functional", "L", "Purchase from Nandini Milk Distributors: Milk 20 L @ ₹58", ["Purchases → New → vendor, item, qty, rate → Save."], "Stock +20 L; weighted-average cost updated; vendor balance shows the purchase.", "INV-03");
c("Inventory", "INV", "P2", "boundary", "L", "Qty 0, -5, 0.001 L", ["Try each in a purchase line."], "0 and negative refused; tiny decimals rounded or accepted with unit precision.", "INV-03");
c("Inventory", "INV", "P1", "functional", "L", "Stock audit: Onions counted 18 kg (system 20)", ["Audits → New → count Onions 18 → Submit."], "Variance −2 kg recorded; stock set to 18 after approval.", "INV-04");
c("Inventory", "INV", "P2", "functional", "L:Onions below reorder level.", "—", ["Open Stock."], "Low-stock badge; alert/notification sent.", "INV-02");
c("Inventory", "INV", "P2", "functional", "L", "Barcode 8901262010016 (Milk)", ["Scan or type the barcode in Stock search."], "Milk (toned) found.", "");
c("Inventory", "INV", "P1", "negative", "L", "/reports, /pos, /bills", ["Open each URL."], "Not available; stock reports only inside Inventory.", "INV-05");
c("Inventory", "KIT", "P2", "functional", "L", "—", ["Open Inventory → Stock."], "Kitchen can view stock but has no Add/Edit/Purchase buttons.", "RBAC-02");
c("Inventory", "INV", "P2", "functional", "L:Two outlets exist.", "Transfer 5 kg rice", ["Transfers → New → to other outlet → Save."], "Source −5 kg, destination +5 kg after receipt.", "");
c("Inventory", "MGR", "P2", "functional", "L", "Recipe for Veg Thali", ["Recipes → Veg Thali → add rice 0.15 kg, oil 0.02 L."], "Food cost per plate calculated; visible to manager, hidden for inventory role.", "INV-05");

// ---- Menu & bulk upload
c("Menu & bulk upload", "MGR", "P1", "functional", "L", "New item \"Rava Idli\" ₹50, category Meals, veg, HSN 996331", ["Menu → Add item → fill → Save."], "Item appears on POS immediately (no refresh needed on other terminals within a few seconds).", "MENU-02");
c("Menu & bulk upload", "MGR", "P1", "functional", "L", "Download template", ["Menu → Import → Download template."], "canavo-menu-template.xlsx downloads with a Menu sheet and a How to fill sheet.", "MENU-05");
c("Menu & bulk upload", "MGR", "P1", "functional", "L", "Template with 10 valid rows", ["Fill 10 items → Upload.", "Review the preview → Confirm."], "Preview lists 10 OK rows; nothing saved until Confirm; after Confirm 10 items exist.", "MENU-05");
c("Menu & bulk upload", "MGR", "P1", "negative", "L", "Rows with: blank name, price \"abc\", GST 7 %, duplicate name", ["Upload."], "Each bad row flagged with a clear reason; valid rows can be imported alone.", "MENU-05");
c("Menu & bulk upload", "MGR", "P2", "negative", "L", "menu.pdf, 6 MB xlsx, renamed .exe→.xlsx", ["Upload each."], "Refused: wrong type / over 5 MB / not a real spreadsheet.", "SEC-01");
c("Menu & bulk upload", "MGR", "P2", "negative", "L", "Cell starting with =HYPERLINK(\"http://x\") in Name", ["Upload, then export menu to Excel."], "Text stored literally; exported cell not executed as a formula.", "REP-02");
c("Menu & bulk upload", "MGR", "P2", "boundary", "L", "1,000 rows", ["Upload a 1,000-row file."], "Preview loads within ~10 s; import completes; POS menu search still fast.", "MENU-05");
c("Menu & bulk upload", "MGR", "P2", "negative", "L", "Image URL http://127.0.0.1/a.jpg", ["Upload a row with an internal image URL."], "Row warned/refused (internal address); no image fetched.", "SEC-02");
c("Menu & bulk upload", "MGR", "P2", "functional", "L", "Photo upload jpg 500 KB", ["Edit Veg Thali → upload photo."], "Photo shows on POS and the online page.", "MENU-04");
c("Menu & bulk upload", "MGR", "P2", "negative", "L", "Category Snacks (has items)", ["Try to delete category Snacks."], "Refused while items exist.", "MENU-01");
c("Menu & bulk upload", "MGR", "P2", "functional", "L", "Kulfi → out of stock", ["Toggle Kulfi unavailable."], "Greyed on POS and SOLD OUT online.", "");
c("Menu & bulk upload", "CSH", "P2", "negative", "L", "/menu", ["Open /menu."], "Not available (cashier sees items only on POS).", "RBAC-02");

// ---- Customers & khata
c("Customers & khata", "CSH", "P1", "functional", "L", "New customer Ritu Singh 9845099002", ["Customers → Add → name + phone → Save."], "Created; searchable by phone; duplicate phone refused.", "CUS-01");
c("Customers & khata", "CSH", "P2", "boundary", "L", "Phones +91 98450 99003, 098450 99004, 12345 67890", ["Add each."], "First two saved as 10 digits (9845099003 / 9845099004); 1234567890 refused (must start 6–9).", "CMP-01");
c("Customers & khata", "MGR", "P1", "functional", "L", "Vikram Rao khata ₹640", ["Customers → Khata → Vikram → Receive ₹640 cash."], "Balance ₹0; payment listed; receipt option.", "CUS-02");
c("Customers & khata", "CSH", "P2", "functional", "L", "Priya Sharma", ["Open Priya's profile."], "Tier Platinum, points, visits, last orders; cashier cannot edit points.", "CUS-01");
c("Customers & khata", "MGR", "P2", "functional", "L", "Redeem 100 points", ["Bill Priya ₹200, redeem 100 points."], "Points discount applied on top of the one offer; balance reduced.", "OFR-05");

// ---- DPDP & consent
c("DPDP & consent", "MGR", "P1", "functional", "L", "Add customer Asha Rao 9845099010 with both consents off (default)", ["Add customer; look at Marketing and WhatsApp opt-in toggles."], "Both default OFF; saving records no consent.", "CMP-01");
c("DPDP & consent", "MGR", "P1", "functional", "L", "Asha Rao: turn on Marketing + WhatsApp opt-in", ["Edit Asha → switch both on → Save."], "Saved with consent date and source (staff); visible on profile.", "CMP-01");
c("DPDP & consent", "OWN", "P1", "functional", "L:Ananya Iyer has birthday today; consent off.", "Birthday wishes job", ["Owner triggers/awaits the daily wishes run.", "Check WhatsApp outbox / log."], "No promotional message to Ananya (no consent); customers with both opt-ins do receive it.", "CMP-01");
c("DPDP & consent", "OWN", "P1", "functional", "L", "Customer Priya Sharma → Export data", ["Open Priya → Download data."], "File with her profile, orders, points, khata; no other customer's data; action in audit log.", "CMP-01");
c("DPDP & consent", "OWN", "P1", "functional", "L:Customer Neha Agarwal, no khata/wallet/open bill.", "Erase", ["Open Neha → Erase / Anonymise → confirm."], "Name/phone masked; old invoices still exist with masked name; customer no longer searchable by phone; audit entry.", "CMP-01");
c("DPDP & consent", "OWN", "P1", "negative", "L:Arjun Nair has khata ₹1,250.", "Erase", ["Try to erase Arjun."], "Refused: settle khata first (also refused with wallet balance or open bill).", "CMP-01");
c("DPDP & consent", "MGR", "P2", "negative", "L", "Export / Erase buttons", ["Open any customer."], "Manager does not see Erase (owner only) — confirm the export rule matches the policy doc.", "CMP-01");
c("DPDP & consent", "CSH", "P2", "negative", "L", "—", ["Open a customer."], "No Export / Erase buttons.", "CMP-01");

// ---- Offers
const ofrPre = "L:Seeded offers: Happy Hour 20 % hot beverages 15:00–17:00; Buy 2 Samosa get 1 Chai free; Combo Vada Pav + Chai ₹35; 10 % off bills over ₹500 (max ₹100). Coupons WELCOME50, FEST10.";
c("Offers", "CSH", "P1", "functional", ofrPre + " Time 15:30.", "Filter Coffee Regular ₹20 × 5", ["Bill the items."], "Happy hour −20 % = −₹20; only one offer line.", "OFR-01");
c("Offers", "CSH", "P1", "functional", ofrPre + " Time 12:00.", "Samosa × 2", ["Add 2 Samosa."], "Suggestion/auto-add of 1 free Masala Chai; chai line ₹0.", "OFR-03");
c("Offers", "CSH", "P1", "functional", ofrPre, "Vada Pav + Masala Chai", ["Add both."], "Combo price ₹35 instead of ₹40.", "OFR-01");
c("Offers", "CSH", "P1", "functional", ofrPre + " Time 15:30.", "Samosa ×2 + Masala Chai ×1 + Filter Coffee ×5", ["Add all."], "Only the single best-saving offer applies: happy hour (20 % of ₹115 hot drinks ≈ −₹23) beats the free chai (−₹15); bill shows one offer line.", "OFR-02");
c("Offers", "CSH", "P1", "functional", ofrPre, "Coupon FEST10 on ₹900", ["Bill ₹900, apply FEST10."], "Only one offer: the 10 % bill discount (−₹90, cap ₹100) beats FEST10 (−₹75, cap ₹75), so the bill shows −₹90 and says the coupon was not applied because a better offer is on. (On a tie the coupon wins.)", "OFR-02");
c("Offers", "CSH", "P1", "negative", ofrPre, "WELCOME50 on ₹150", ["Apply WELCOME50."], "Refused: minimum ₹200.", "OFR-04");
c("Offers", "CSH", "P1", "negative", ofrPre, "WELCOME50 twice for Priya 9845010001", ["Use it on one bill, then again on another bill for Priya."], "Second use refused (once per customer).", "OFR-04");
c("Offers", "CSH", "P2", "negative", ofrPre, "Coupon \"fest10 \" (lower case + space), \"XYZ\"", ["Apply each."], "fest10 accepted (case/space insensitive) or clear message; XYZ \"invalid coupon\".", "OFR-04");
c("Offers", "MGR", "P2", "functional", "L", "New coupon CHAI5 flat ₹5, valid today only", ["Offers → Coupons → New."], "Works today; refused tomorrow (expired).", "OFR-04");
c("Offers", "MGR", "P2", "functional", "L", "Pause Happy Hour", ["Offers → Happy Hour → Disable."], "Not applied any more on POS and online page; offers strip updates.", "OFR-01");

// ---- Attendance
c("Attendance", "CSH", "P1", "functional", "Mobile app; inside the outlet (Koramangala, 200 m geofence).", "PIN 1234", ["Clock in with PIN, allow location, take selfie if asked."], "Clocked in at IST time; late flag if after shift grace (Morning 07:00 + 10 min).", "ATT-01");
c("Attendance", "CSH", "P1", "negative", "Mobile app; 1 km away from the outlet.", "PIN 1234", ["Try to clock in."], "Refused: outside outlet area (distance shown).", "ATT-01");
c("Attendance", "CSH", "P1", "negative", "Mobile app at outlet.", "PIN 0000 × 5", ["Enter a wrong PIN 5 times."], "Refused; lockout after repeated failures.", "AUTH-03");
c("Attendance", "MGR", "P2", "functional", "L", "Mark Ravi Cook present 07:05–15:10 yesterday", ["Attendance → manual entry."], "Saved; overtime 10 min; audit entry.", "ATT-02");
c("Attendance", "KIT", "P2", "functional", "L", "Leave 2 days", ["My attendance & leave → Request leave."], "Request pending; manager sees and approves; calendar updates.", "ATT-03");
c("Attendance", "OWN", "P2", "functional", "L", "Salary sheet this month", ["Attendance → Salary sheet → Export Excel."], "Monthly/daily salary computed from attendance; ₹ in Indian format.", "ATT-03");

// ---- Staff
c("Staff", "OWN", "P1", "functional", "L", "New cashier Pooja 9845099020, PIN 4321", ["Staff → Add → role Cashier → Save."], "Pooja can log in; appears in staff list.", "RBAC-06");
c("Staff", "MGR", "P1", "negative", "L", "Role options", ["Staff → Add → open the Role list."], "Manager cannot create Owner or Manager-above roles.", "RBAC-06");
c("Staff", "MGR", "P2", "negative", "L", "Own profile", ["Open your own staff profile."], "Cannot change own role, status or outlets.", "OUT-02");
c("Staff", "OWN", "P2", "functional", "L", "Custom role \"Cashier – no khata\"", ["Staff → Custom roles → base Cashier, untick customer view.", "Assign to Pooja; Pooja logs in."], "Pooja's Customers/Khata menu hidden; cannot add permissions beyond the base role.", "RBAC-01");
c("Staff", "OWN", "P2", "functional", "L", "A 12-digit test Aadhaar with a valid Verhoeff check digit (not a real person's)", ["Admin → Staff Aadhaar → add for Pooja."], "Shown masked XXXX-XXXX-<last 4>; a number with a wrong check digit is refused; reveal asks reason and is audited.", "OUT-03");
c("Staff", "AUD", "P2", "negative", "L", "—", ["Open Staff."], "Read-only list; no add/edit/Aadhaar reveal.", "RBAC-02");

// ---- Reports & GST
c("Reports & GST", "OWN", "P1", "functional", "L:Bills today; note their sum from Bills.", "Today", ["Reports → Sales → Today."], "Net sales equals the Bills list total (cancelled excluded, refunds deducted).", "REP-01");
c("Reports & GST", "ACC", "P1", "functional", "L", "Last month", ["Reports → GST / GSTR-1 → last month → download JSON + Excel."], "B2CS by rate and HSN summary add up to bill totals net of credit notes; document summary counts cancelled bills.", "REP-01");
c("Reports & GST", "OWN", "P1", "functional", "L", "Export Excel and PDF of Sales", ["Download both."], "Same numbers in screen, Excel and PDF; amounts in lakh grouping (e.g. 1,25,000.00).", "REP-02");
c("Reports & GST", "OWN", "P2", "functional", "L:2 outlets.", "All outlets", ["Reports → All outlets."], "Per-outlet rows plus total = sum of rows.", "REP-03");
c("Reports & GST", "OWN", "P2", "functional", "L", "Daily email to owner@canavo.local", ["Admin → Report schedules → Daily sales, items, GST."], "Email arrives next morning (IST) from the store SMTP if configured.", "REP-03");
c("Reports & GST", "INV", "P1", "negative", "L", "/reports", ["Open /reports."], "Not available for your role.", "REP-04");
c("Reports & GST", "MGR", "P2", "functional", "L", "Date range crossing midnight IST", ["Bill one order 23:55 and one 00:05.", "Report for each day."], "Each bill in its IST day.", "CMP-01");

// ---- Settings & taxes
c("Settings & taxes", "OWN", "P1", "functional", "L", "GSTIN 29ABCDE1234F1ZX (wrong check char)", ["Settings → Outlet → change GSTIN → Save."], "Refused: invalid GSTIN checksum.", "OUT-01");
c("Settings & taxes", "OWN", "P1", "negative", "L", "A valid Tamil Nadu GSTIN (state code 33) on the Karnataka outlet", ["Save."], "Refused: state code does not match the outlet state 29.", "OUT-01");
c("Settings & taxes", "MGR", "P1", "functional", "L", "Composition scheme on (test outlet)", ["GST & Taxes → Composition → Save.", "Bill an item."], "Receipt titled \"BILL OF SUPPLY\" with the composition declaration and no tax lines.", "BILL-03");
c("Settings & taxes", "MGR", "P2", "functional", "L", "Service charge 5 % dine-in", ["Set service charge.", "Bill a dine-in and a takeaway."], "Dine-in only has service charge (taxed); takeaway does not.", "BILL-06");
c("Settings & taxes", "CSH", "P2", "functional", "L", "—", ["Open Settings."], "Read-only outlet info + printer setup; no GST & Taxes / Integrations tabs.", "RBAC-02");
c("Settings & taxes", "OWN", "P2", "functional", "L", "FSSAI empty", ["Clear FSSAI → Save."], "Warning that FSSAI is missing (save allowed).", "CMP-01");
c("Settings & taxes", "OWN", "P2", "functional", "L", "Invoice prefix \"CANTN\"", ["Change prefix → bill once."], "Bill number ≤16 characters (e.g. CANTN/2026-27/00001 style); refunds still work.", "BILL-11");

// ---- Integrations
const intPre = "L:Settings → Integrations. Use Razorpay TEST keys (rzp_test_…) and a test SMTP (e.g. Mailtrap) — never live keys.";
c("Integrations", "OWN", "P1", "functional", intPre, "Razorpay key ID rzp_test_xxx, secret, webhook secret", ["Razorpay card → enter keys → Save → Test connection."], "\"Connected\"; secret fields show only ••••last4 afterwards; webhook URL with the store key shown to copy.", "");
c("Integrations", "OWN", "P1", "negative", intPre, "Wrong key secret", ["Save wrong secret → Test connection."], "Clear failure message without echoing the secret.", "");
c("Integrations", "OWN", "P2", "negative", intPre, "Test connection 11 times in 15 min", ["Press Test 11 times."], "11th refused: rate limited (10 per 15 min).", "");
c("Integrations", "MGR", "P1", "negative", "L", "Integrations page", ["Open Settings → Integrations."], "Status only (Connected / Not connected); no hints, no edit fields.", "");
c("Integrations", "OWN", "P1", "functional", intPre, "SMTP host smtp.mailtrap.io port 587", ["Email card → fill → Save → Test."], "Test email arrives from the store's from-address.", "");
c("Integrations", "OWN", "P1", "negative", intPre, "SMTP host 127.0.0.1 / 10.0.0.5 / http://x", ["Save each (production build)."], "Refused: internal / URL hosts not allowed.", "");
c("Integrations", "OWN", "P2", "functional", intPre, "MSG91 auth key + DLT sender + OTP template id", ["SMS card → Save → Test."], "Customer OTP on the online page uses the store's MSG91 account.", "");
c("Integrations", "OWN", "P2", "functional", intPre, "Rotate webhook key", ["Razorpay → Rotate webhook key → confirm."], "New URL shown; old URL now answers 401; update Razorpay dashboard.", "");
c("Integrations", "OWN", "P1", "functional", intPre, "Admin → Export data", ["Export all data, search the file for the secret."], "No secrets / ciphertext in the export.", "SEC-04");
c("Integrations", "SA", "P1", "negative", "L", "—", ["Look for any business's integrations in the platform console."], "No integration details or hints visible to Super Admin.", "RBAC-05");
c("Integrations", "OWN", "P2", "functional", intPre, "Delete Razorpay", ["Remove Razorpay → bill with UPI."], "Falls back to plain UPI QR (cashier confirms), unless the platform shared account is on.", "");

// ---- WhatsApp templates
const waPre = "L:WhatsApp connected in Integrations (Meta test number or WATI sandbox).";
c("WhatsApp templates", "OWN", "P1", "functional", waPre, "—", ["Settings → WhatsApp templates."], "How-it-works card + one card per type: receipt, khata reminder, birthday, anniversary, delivery update, staff alert, test.", "");
c("WhatsApp templates", "OWN", "P1", "functional", waPre, "Receipt template name canavo_receipt, language en", ["Fill the receipt card → Save → Send test to your phone."], "Test WhatsApp arrives with variables filled.", "");
c("WhatsApp templates", "OWN", "P2", "negative", waPre, "Template name with spaces \"my receipt\"", ["Save."], "Validation error (Meta names are lowercase_underscore).", "");
c("WhatsApp templates", "MGR", "P1", "negative", "L", "—", ["Open WhatsApp templates."], "Read-only for manager (owner-only edits).", "");
c("WhatsApp templates", "OWN", "P2", "functional", waPre, "Turn off delivery update", ["Untick automatic delivery updates → Save; complete a delivery."], "No delivery WhatsApp sent.", "");

// ---- Appearance
c("Appearance", "CSH", "P2", "functional", "L", "Theme Dark", ["Account → Appearance → Dark."], "Whole app dark immediately; stays after reload and re-login; other users unaffected.", "");
c("Appearance", "CSH", "P2", "functional", "L", "Text size Large, density Compact", ["Change both."], "Text larger, spacing tighter; POS still fits a 1366 px screen without overlap.", "");
c("Appearance", "OWN", "P2", "functional", "L", "Business brand accent green", ["Appearance → Business brand → choose green → Save.", "Log in as cashier."], "Cashier sees the green accent unless they chose their own; online ordering page uses the brand colour.", "");
c("Appearance", "CSH", "P3", "functional", "L", "Theme System", ["Set System; switch the OS to dark mode."], "App follows the OS without reload.", "");
c("Appearance", "MGR", "P3", "negative", "L", "—", ["Look for the Business brand section."], "Not shown (owner only).", "");
c("Appearance", "ANY", "P3", "UI", "Dark theme on.", "—", ["Open POS, Bills drawer, KDS, receipts preview, dialogs."], "All readable (no black-on-black); receipt preview stays white like paper.", "UI-01");

// ---- Cinema seat ordering
const cinPre = "L:THEATRE module on. Cinema → Screens & seats: Screen 1 with rows F–G, seats 1–12 (Bulk seats). Showtimes: today, \"Demo Film\", start now−30 min, interval in 20 min, orders close 5 min after interval.";
c("Cinema seat ordering", "OWN", "P1", "functional", "L", "Screen 1, rows F–G, seats 1–12", ["Cinema → Screens & seats → Add screen \"Screen 1\".", "Bulk seats → rows F–G, 1–12, skip G6 → Save."], "Seat map with \"Screen this way\"; G6 gap; 23 seats.", "");
c("Cinema seat ordering", "OWN", "P1", "functional", cinPre, "Print seat sheets", ["Screens & seats → Print QR sheets → Print preview."], "A4 pages, 12 seats per page, seat label and QR, dashed cut lines; screen poster with a big QR.", "");
c("Cinema seat ordering", "GST", "P1", "functional", cinPre + " Scan seat F12 QR on a phone in a dark room.", "Masala Chai + Samosa, deliver at interval, UPI", ["Scan.", "Add items → choose \"At interval\" → pay UPI."], "Dark cinema page opens with no white flash; banner \"Screen 1 · F12\"; \"Ordering closes in N min\"; order strip shows the stage.", "");
c("Cinema seat ordering", "GST", "P2", "functional", cinPre, "Deliver now / Pick up at counter", ["Place one order \"to seat now\" and one \"counter pickup\"."], "Counter order shows a token number; KOT badges TO SEAT NOW and COUNTER #n.", "");
c("Cinema seat ordering", "GST", "P1", "negative", cinPre + " Time is after the order close time.", "—", ["Open the seat page."], "Ordering closed message; cannot place orders.", "");
c("Cinema seat ordering", "WTR", "P1", "functional", cinPre + " Log in as waiter (runner).", "—", ["Cinema → Runner board."], "Tabs per screen with counts; orders grouped by row, sorted by seat; header shows \"Interval in mm:ss\".", "");
c("Cinema seat ordering", "CSH", "P2", "functional", cinPre + " A UPI seat order pending (no webhook).", "UPI received", ["Runner board → order → UPI received."], "Order marked paid.", "");
c("Cinema seat ordering", "OWN", "P2", "functional", cinPre, "Rotate screen QR", ["Screens & seats → New screen QR → confirm."], "Old poster QR stops working; seat QRs listed per seat.", "");
c("Cinema seat ordering", "OWN", "P2", "functional", "L", "Showtimes overlapping on Screen 1", ["Add a show overlapping an existing one."], "Refused or warned (409 message shown).", "");
c("Cinema seat ordering", "OWN", "P2", "functional", "L", "Reports → Cinema tab", ["Open Reports → Cinema for today."], "Orders, sales, average order, sales by screen, by-show table; Excel/PDF export.", "");
c("Cinema seat ordering", "GST", "P3", "UI", cinPre + " Low-end Android, brightness low.", "—", ["Use the seat page."], "No animations/toasts/vibration; dim amber accent; readable.", "");

// ---- Canteen
c("Canteen", "MGR", "P2", "functional", "L", "Corporate account \"Acme IT\" with 50 % subsidy", ["Canteen → Corporate accounts → New."], "Saved; GSTIN validated if entered.", "");
c("Canteen", "MGR", "P2", "functional", "L", "Member card for employee E101 with ₹500 wallet", ["Members & cards → Add → top up ₹500."], "Card can pay at POS; wallet reduces.", "");
c("Canteen", "CSH", "P2", "negative", "L", "Member wallet ₹20, bill ₹45", ["Pay by member card."], "Refused or split with another mode; never negative wallet.", "");
c("Canteen", "MGR", "P3", "functional", "L", "Meal slot Lunch 12:00–14:00", ["Meal slots → New; pre-order for tomorrow; Production plan."], "Production plan shows tomorrow's quantities.", "");

// ---- Cash drawer & gift cards
c("Cash drawer & gift cards", "CSH", "P1", "functional", "L", "Opening float ₹2,000", ["Cash drawer → Open shift with ₹2,000.", "Bill 3 cash bills.", "Close shift, count cash."], "Expected cash = float + cash sales; difference shown and saved.", "");
c("Cash drawer & gift cards", "CSH", "P2", "functional", "L", "Gift card ₹500", ["Gift cards → Sell ₹500 → pay cash.", "Redeem ₹300 on a bill."], "Balance ₹200; history shows both.", "");
c("Cash drawer & gift cards", "CSH", "P2", "negative", "L", "Gift card code wrong / expired", ["Redeem with a wrong code."], "Refused with a clear message.", "");

// ---- Reservations
c("Reservations", "CSH", "P2", "functional", "L", "Reservation 4 people, tomorrow 20:00, T6, phone 9845010005", ["Reservations → New."], "Listed; T6 shows reserved near the time.", "RES-01");
c("Reservations", "CSH", "P2", "functional", "L", "Pre-order for pickup at 13:00", ["Create a pre-order."], "KOT released before 13:00 by the lead time.", "RES-01");

// ---- Platform
c("Platform", "SA", "P1", "functional", "L", "New business \"Test Dhaba\", owner test.owner@example.com, modules Billing+KOT", ["Platform → Businesses → Onboard."], "Business and owner created; owner can log in and sees only Billing/KOT screens.", "PLAT-01");
c("Platform", "SA", "P1", "functional", "L", "Demo Hotel", ["Open Demo Hotel in the console."], "Account info, modules, counts only — no sales, staff names, customers or bills.", "PLAT-02");
c("Platform", "SA", "P1", "functional", "L", "Suspend Test Dhaba", ["Suspend → confirm.", "Its owner tries to use the app."], "Owner logged out and refused at login; Activate restores access.", "PLAT-04");
c("Platform", "SA", "P1", "functional", "L", "Turn off INVENTORY for Test Dhaba", ["Edit modules → untick Inventory."], "Owner's Inventory menu disappears; direct URL not available.", "RBAC-07");
c("Platform", "SA", "P1", "functional", "L", "Backups", ["Admin → Backups → Create backup."], "Backup listed; no Download button; Restore requires confirmation.", "PLAT-06");
c("Platform", "SA", "P2", "functional", "L", "Reset owner password", ["Business → owner → Reset password."], "Owner signed out everywhere; new password works.", "PLAT-03");
c("Platform", "SUP", "P2", "negative", "L", "—", ["Try to edit a business / suspend / onboard."], "Read-only console; no write buttons.", "");
c("Platform", "OWN", "P2", "functional", "L", "Support access grant 24 h", ["Settings → Support access → grant."], "Support user can open the support view for 24 h; no secrets/Aadhaar visible; revoke works.", "");

// ---- Admin, audit & export
c("Admin, audit & export", "OWN", "P1", "functional", "L", "—", ["Admin → Audit log; filter last hour."], "Your recent actions (discount approvals, cancels, settings changes) with user and IST time.", "");
c("Admin, audit & export", "OWN", "P1", "functional", "L", "Export data", ["Admin → Export data → Download."], "ZIP/Excel of own business only; no password/PIN hashes, tokens, Aadhaar ciphertext or keys.", "SEC-04");
c("Admin, audit & export", "AUD", "P2", "functional", "L", "—", ["Open the Audit log."], "Visible read-only.", "");
c("Admin, audit & export", "SA", "P2", "functional", "L", "—", ["Open the Audit log."], "Only platform actions (onboard, suspend, backups), no hotel actions.", "PLAT-05");

// ---- Mobile app
c("Mobile app", "CSH", "P1", "functional", "Expo app installed (see REAL_DEVICE_CHECKLIST).", `cashier@canavo.local / ${PW}`, ["Sign in.", "Bill Masala Chai ×2 cash."], "Bill created; appears on the web Bills page.", "MOB-01");
c("Mobile app", "CSH", "P1", "functional", "Mobile app signed in.", "Airplane mode, 3 cash bills", ["Turn on airplane mode.", "Bill 3 orders.", "Force-stop and reopen the app.", "Turn airplane mode off."], "Bills kept as pending after restart; sync once online; each bill appears exactly once on the web.", "BILL-14");
c("Mobile app", "KIT", "P1", "functional", "Mobile app with notifications allowed.", "App killed", ["Kill the app.", "Cashier bills an order."], "Push notification for the new KOT; tap opens the kitchen screen.", "NOT-01");
c("Mobile app", "DEL", "P1", "functional", "Mobile app, location allowed (precise).", "—", ["Clock in, accept a run, drive away and back."], "Live location on the outlet board; \"back at outlet\" when within the geofence.", "DEL-03");
c("Mobile app", "CSH", "P2", "functional", "Bluetooth 58 mm printer paired.", "Bill with \"मसाला चाय\" item name", ["Print receipt."], "₹ symbol and Hindi print correctly or fall back legibly (no garbage).", "BILL-13");
c("Mobile app", "ANY", "P2", "UI", "Font scaling 1.3× in phone settings.", "—", ["Open POS, cart, payment."], "No clipped buttons; text wraps.", "");
c("Mobile app", "CSH", "P2", "functional", "Mobile app.", "Logout", ["Log out; ask kitchen to send an order."], "No push to the logged-out device.", "NOT-01");

// ---- Offline & resilience (web)
c("Offline & resilience", "CSH", "P1", "functional", "L:Web POS.", "Disconnect network mid-bill", ["Add items.", "Disconnect Wi-Fi.", "Pay cash."], "Offline banner; bill saved locally with a temporary number; syncs on reconnect without duplicates.", "BILL-14");
c("Offline & resilience", "CSH", "P1", "negative", "L:Web POS.", "Double-click Pay", ["Click Confirm payment twice quickly."], "One bill, one payment.", "BILL-14");
c("Offline & resilience", "CSH", "P2", "functional", "L", "API down (ask dev to stop the API)", ["Use the app."], "Friendly \"Can't reach server\" message; not logged out; recovers when API is back.", "");

// ---- Notifications
c("Notifications", "MGR", "P2", "functional", "L", "Low stock, waiting delivery, call waiter", ["Trigger each event."], "Bell shows each with the right deep link; marking read clears the badge.", "NOT-01");
c("Notifications", "CSH", "P2", "negative", "L", "Events from another outlet", ["Trigger an event in outlet 2."], "Cashier of outlet 1 does not see it.", "RT-01");

// ---- Localization
c("Localization", "CSH", "P2", "functional", "L", "₹1,23,45,678.50", ["Look at large totals in reports/dashboard."], "Shown as ₹1,23,45,678.50 or ₹1.23 Cr — never 12,345,678.", "CMP-01");
c("Localization", "MGR", "P2", "boundary", "L", "Item name 60 chars: \"Special Hyderabadi Dum Chicken Biryani with Raita and Salan XL\"", ["Add the item; bill it; print 58 mm."], "Wraps neatly on POS card and receipt; price column aligned.", "");
c("Localization", "MGR", "P2", "functional", "L", "Names in Hindi, Kannada, Tamil: \"मसाला चाय\", \"ಮಸಾಲ ದೋಸೆ\", \"இட்லி\"", ["Create items; search for them; print."], "Stored and displayed correctly; search finds them; receipts print or fall back.", "");
c("Localization", "MGR", "P3", "boundary", "L", "Special characters: Rahul & Sons <b>x</b> \"quote\" 'apos' ; emoji 🍛", ["Use as customer name and item note."], "Shown literally (no HTML rendering, no crash).", "SEC-03");

// ---- UI & usability
c("UI & usability", "OWN", "P2", "UI", "L:Phone 390 px.", "—", ["Open each sidebar group via the bottom bar."], "No horizontal scrolling; tabs not duplicated; one primary action per page.", "UI-01");
c("UI & usability", "CSH", "P2", "usability", "L", "Bill a 5-item order (see USABILITY_TEST)", ["Time from first tap to receipt."], "≤ 45 s for a trained cashier.", "");
c("UI & usability", "ANY", "P3", "UI", "Any page with a dialog.", "Tab key", ["Open a dialog; press Tab repeatedly."], "Focus stays inside the dialog; Esc closes; focus returns to the button.", "UI-01");

// ---------------------------------------------------------------- role × page matrix (from rbac.ts + nav.ts)
const PAGES = [
  ["/dashboard", "Dashboard", { any: ["report:view"] }],
  ["/pos", "POS", { any: ["order:create"], all: ["payment:collect"] }],
  ["/tables", "Tables", { any: ["table:serve", "table:manage"] }],
  ["/online-orders", "Online orders", { any: ["channel:manage", "order:create"] }],
  ["/bills", "Bills", { any: ["bills:view"] }],
  ["/cash-drawer", "Cash drawer", { any: ["payment:collect"] }],
  ["/reservations", "Reservations", { any: ["reservation:manage"] }],
  ["/kitchen", "Kitchen display", { any: ["kot:view"] }],
  ["/menu", "Menu", { any: ["menu:manage"] }],
  ["/theatre/board", "Cinema runner board", { any: ["table:serve"] }],
  ["/theatre", "Cinema screens & seats", { any: ["table:manage"] }],
  ["/canteen/accounts", "Canteen accounts", { any: ["canteen:manage"] }],
  ["/delivery", "Delivery board / My deliveries", { any: ["delivery:manage", "delivery:own"] }],
  ["/inventory", "Inventory stock", { any: ["inventory:view", "inventory:manage"] }],
  ["/customers", "Customers", { any: ["customer:view"] }],
  ["/offers", "Offers & coupons", { any: ["offer:manage"] }],
  ["/reports", "Reports", { any: ["report:view"] }],
  ["/staff", "Staff", { any: ["staff:view"] }],
  ["/attendance", "Attendance (manage)", { any: ["attendance:manage"] }],
  ["/my-attendance", "My attendance & leave", { any: ["attendance:self"] }],
  ["/settings", "Outlet settings", { any: ["settings:view"] }],
  ["/settings/taxes", "GST & Taxes", { any: ["settings:billing"], all: ["settings:view"] }],
  ["/settings/integrations", "Integrations", { any: ["settings:outlet"], all: ["settings:view"] }],
  ["/settings/online-ordering", "QR & online ordering", { any: ["channel:manage"] }],
  ["/outlets", "Outlets", { any: ["outlet:manage"] }],
  ["/admin/audit", "Audit log", { any: ["audit:view"], scope: "any" }],
  ["/admin/export", "Export data", { any: ["data:export"] }],
  ["/platform", "Platform console", { any: ["platform:view"], scope: "platform" }],
];
const MATRIX_ROLES = ["OWN", "MGR", "CSH", "KIT", "INV", "DEL", "WTR", "ACC", "AUD", "SA", "SUP"];
for (const r of MATRIX_ROLES) {
  const perms = ROLE_PERMISSIONS[ROLE[r].key];
  const platform = ["SA", "SUP"].includes(r);
  for (const [href, label, rule] of PAGES) {
    const scope = rule.scope ?? "business";
    const scopeOk = scope === "platform" ? platform : scope === "business" ? !platform : true;
    const ok = scopeOk && rule.any.some((p) => perms.includes(p)) && (rule.all ?? []).every((p) => perms.includes(p));
    const partner = href === "/delivery" && perms.includes("delivery:own") && !perms.includes("delivery:manage");
    const expected = ok
      ? `\"${partner ? "My deliveries" : label}\" is reachable from the sidebar (or its category tabs) and the page loads with data, no error and no \"isn't available\" message.`
      : `\"${label}\" is NOT in the sidebar/tabs, and opening ${href} directly shows \"This page isn't available for your role\" with a button back to your home screen. No data from the page flashes on screen.`;
    c("Access & roles", r, ok ? "P2" : "P1", ok ? "functional" : "negative", "L",
      `URL ${href}`,
      ["Look through the sidebar and the tabs at the top of each category for the page.", `Type ${href} after the site address and press Enter.`],
      expected, ok ? "RBAC-01" : "RBAC-02");
  }
}

// ---------------------------------------------------------------- write CSV
const COLS = [
  ["TC ID", "id", 13], ["Module", "module", 20], ["Role", "role", 16], ["Priority", "priority", 8], ["Type", "type", 11],
  ["Preconditions", "pre", 42], ["Test data", "data", 32], ["Steps", "steps", 52], ["Expected result", "expected", 52],
  ["Actual result", "", 30], ["Status", "", 10], ["Bug ID", "", 10], ["Tester", "", 12], ["Date", "", 11],
  ["Device/Browser", "", 18], ["RTM ref", "rtm", 9],
];
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = [COLS.map((x) => x[0]).join(","), ...cases.map((t) => COLS.map(([, k]) => csvCell(k ? String(t[k] ?? "") : "")).join(","))].join("\n") + "\n";
writeFileSync(join(here, "MANUAL_TEST_CASES.csv"), "\uFEFF" + csv);

// ---------------------------------------------------------------- write XLSX
const modules = Object.keys(MOD).filter((m) => cases.some((t) => t.module === m));
const wb = new ExcelJS.Workbook();
wb.creator = "CANAVO QA Phase 15";
const head = (ws) => {
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  ws.getRow(1).alignment = { vertical: "middle", wrapText: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
};
const n = cases.length;

// Summary first so it opens on top
const sum = wb.addWorksheet("Summary");
const tc = wb.addWorksheet("Test Cases");
tc.columns = COLS.map(([h, , w]) => ({ header: h, width: w }));
for (const t of cases) tc.addRow(COLS.map(([, k]) => (k ? t[k] ?? "" : "")));
head(tc);
tc.autoFilter = { from: "A1", to: `P${n + 1}` };
for (let i = 2; i <= n + 1; i++) {
  tc.getRow(i).alignment = { vertical: "top", wrapText: true };
  tc.getCell(`K${i}`).dataValidation = { type: "list", allowBlank: true, formulae: ["Lists!$A$2:$A$5"] };
  tc.getCell(`N${i}`).dataValidation = { type: "date", allowBlank: true, operator: "greaterThan", formulae: [new Date(2026, 0, 1)] };
  tc.getCell(`N${i}`).numFmt = "dd-mmm-yyyy";
}
tc.addConditionalFormatting({
  ref: `K2:K${n + 1}`,
  rules: [
    { type: "containsText", operator: "containsText", text: "Pass", priority: 1, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC6EFCE" } } } },
    { type: "containsText", operator: "containsText", text: "Fail", priority: 2, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } } } },
    { type: "containsText", operator: "containsText", text: "Blocked", priority: 3, style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFEB9C" } } } },
  ],
});

sum.columns = [
  { header: "Module", width: 26 }, { header: "Planned", width: 9 }, { header: "P1", width: 6 }, { header: "Executed", width: 9 },
  { header: "Passed", width: 8 }, { header: "Failed", width: 8 }, { header: "Blocked", width: 8 }, { header: "NA", width: 6 },
  { header: "Not run", width: 8 }, { header: "Executed %", width: 10 }, { header: "Pass %", width: 8 },
];
const R = "'Test Cases'!";
modules.forEach((m, i) => {
  const r = i + 2;
  const cnt = (st) => `COUNTIFS(${R}$B:$B,$A${r},${R}$K:$K,"${st}")`;
  sum.addRow([
    m,
    { formula: `COUNTIF(${R}$B:$B,$A${r})` },
    { formula: `COUNTIFS(${R}$B:$B,$A${r},${R}$D:$D,"P1")` },
    { formula: `E${r}+F${r}+H${r}` },
    { formula: cnt("Pass") }, { formula: cnt("Fail") }, { formula: cnt("Blocked") }, { formula: cnt("NA") },
    { formula: `B${r}-D${r}-G${r}` },
    { formula: `IF(B${r}=0,0,D${r}/B${r})` },
    { formula: `IF(D${r}=0,0,E${r}/D${r})` },
  ]);
});
const last = modules.length + 1;
const tot = last + 1;
sum.addRow(["TOTAL", ...["B", "C", "D", "E", "F", "G", "H", "I"].map((col) => ({ formula: `SUM(${col}2:${col}${last})` })),
  { formula: `IF(B${tot}=0,0,D${tot}/B${tot})` }, { formula: `IF(D${tot}=0,0,E${tot}/D${tot})` }]);
sum.getRow(tot).font = { bold: true };
for (let r = 2; r <= tot; r++) for (const col of ["J", "K"]) sum.getCell(`${col}${r}`).numFmt = "0%";
head(sum);
sum.addRow([]);
sum.addRow(["Executed = Pass + Fail + NA. Not run = Planned − Executed − Blocked. Fill Status in 'Test Cases' (drop-down)."]);
sum.addRow(["Exit criteria (TEST_STRATEGY §): 100 % P1 executed, 0 open P0/P1 bugs, ≥ 95 % pass overall."]);
sum.addRow(["By role", "Planned", "Passed", "Failed", "Blocked"]);
const roleHdr = sum.lastRow.number;
sum.getRow(roleHdr).font = { bold: true };
const roles = [...new Set(cases.map((t) => t.role))];
for (const role of roles) {
  const r = sum.lastRow.number + 1;
  sum.addRow([role, { formula: `COUNTIF(${R}$C:$C,$A${r})` },
    ...["Pass", "Fail", "Blocked"].map((st) => ({ formula: `COUNTIFS(${R}$C:$C,$A${r},${R}$K:$K,"${st}")` }))]);
}

const log = wb.addWorksheet("Daily Log");
log.columns = [
  ["Date", 12], ["Tester", 14], ["Build / commit SHA", 16], ["Environment", 14], ["Device / Browser", 20], ["Modules / TC range", 26],
  ["Planned today", 9], ["Executed", 9], ["Passed", 8], ["Failed", 8], ["Blocked", 8], ["Bugs raised (IDs)", 18], ["Blockers / notes", 40], ["Hours", 7],
].map(([header, width]) => ({ header, width }));
for (let i = 0; i < 60; i++) {
  const r = i + 2;
  log.addRow(["", "", "", "", "", "", "", { formula: `IF(I${r}+J${r}="","",I${r}+J${r})` }]);
  log.getCell(`A${r}`).numFmt = "dd-mmm-yyyy";
  log.getCell(`D${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"LOCAL,STAGING,PROD-LIKE,DEVICE"'] };
}
head(log);

const bug = wb.addWorksheet("Bug Log");
bug.columns = ["Bug ID", "Title", "Severity", "Priority", "Module", "Role", "TC ID", "Environment", "Found by", "Date", "Status", "Fixed in", "Verified by"].map((h) => ({ header: h, width: h === "Title" ? 50 : 13 }));
head(bug);

const lists = wb.addWorksheet("Lists");
lists.addRows([["Status"], ["Pass"], ["Fail"], ["Blocked"], ["NA"]]);
lists.state = "veryHidden";

// ---------------------------------------------------------------- compatibility matrix
const COMPAT = {
  cols: ["390×844 phone", "412×915 phone", "768×1024 tablet", "1024×768 POS touch", "1366×768 laptop", "1920×1080 desktop / KDS TV"],
  rows: [
    ["Chrome (latest)", "Windows 10 / 11", ["—", "—", "—", "P1", "P1", "P1"]],
    ["Edge (latest)", "Windows 10 / 11", ["—", "—", "—", "P1", "P1", "P2"]],
    ["Firefox (latest)", "Windows 11", ["—", "—", "—", "—", "P2", "P2"]],
    ["Chrome (latest)", "macOS 14 / 15", ["—", "—", "—", "—", "P2", "P2"]],
    ["Safari 17 / 18", "macOS 14 / 15", ["—", "—", "—", "—", "P2", "P2"]],
    ["Chrome (latest)", "Android 10 / 12 / 14", ["P1", "P1", "P1", "P2", "—", "—"]],
    ["Samsung Internet", "Android 13 / 14", ["P2", "P2", "P2", "—", "—", "—"]],
    ["Safari", "iOS 17 / 18 (iPhone)", ["P1", "—", "—", "—", "—", "—"]],
    ["Safari", "iPadOS 17 / 18", ["—", "—", "P2", "P2", "—", "—"]],
    ["Chrome (latest)", "Ubuntu 22.04 / ChromeOS", ["—", "—", "—", "P3", "P3", "P2"]],
    ["Android WebView / in-app (WhatsApp, Instagram link)", "Android 12+ / iOS 17+", ["P1", "P2", "—", "—", "—", "—"]],
  ],
  scope: {
    P1: "Full journey for the screens that device class is used for (POS / KDS / online ordering / partner portal)",
    P2: "Smoke: login, main journey once, dark mode, one dialog, print preview",
    P3: "Opportunistic",
  },
};
const cmp = wb.addWorksheet("Compatibility");
cmp.columns = [{ header: "Browser", width: 28 }, { header: "OS", width: 22 }, ...COMPAT.cols.map((h) => ({ header: h, width: 15 })), { header: "Result / notes", width: 30 }];
for (const [b, os, cells] of COMPAT.rows) cmp.addRow([b, os, ...cells, ""]);
head(cmp);
await wb.xlsx.writeFile(join(here, "MANUAL_TEST_CASES.xlsx"));

const compatMd = `# Compatibility matrix (browsers × OS × screen sizes)

Generated by \`build.mjs\` (also the **Compatibility** sheet in MANUAL_TEST_CASES.xlsx). Run against the build under test
and record the result in the sheet. Cell = priority of coverage on that combination ("—" = not needed).

| Browser | OS | ${COMPAT.cols.join(" | ")} |
|---|---|${COMPAT.cols.map(() => "---").join("|")}|
${COMPAT.rows.map(([b, os, cells]) => `| ${b} | ${os} | ${cells.join(" | ")} |`).join("\n")}

${Object.entries(COMPAT.scope).map(([k, v]) => `- **${k}:** ${v}`).join("\n")}

## Screens per device class
| Device class | Screens to exercise |
|---|---|
| Phone (390 / 412) | Online ordering \`/o/<slug>\`, QR table \`/t/<token>\`, cinema seat page, partner "My deliveries", login, Bills drawer |
| Tablet / POS touch (768, 1024) | POS (5-item bill, split pay, discount PIN), Tables floor plan, KDS, Runner board |
| Laptop / desktop | Every sidebar page for owner and manager; Reports + exports; Menu import; Settings → Integrations / WhatsApp |
| 1920 TV (KDS wall) | Kitchen display at 3 m, Runner board, auto-refresh over 8 h |

## Per-cell checklist
Layout fits (no horizontal scroll) · fonts load (₹, Indic) · dialogs open and close · date/time pickers usable ·
print preview (receipt 58/80 mm, QR sheets A4) · file download/upload (Excel) · sound on new KOT/online order ·
dark mode · keyboard focus visible (desktop) · back button behaviour.

Already automated (Phase 11): Chromium all journeys; Firefox / WebKit cashier bill + online ordering only. Everything else
here is manual.
`;
writeFileSync(join(here, "COMPATIBILITY_MATRIX.md"), compatMd);

// ---------------------------------------------------------------- markdown index
const byMod = modules.map((m) => {
  const list = cases.filter((t) => t.module === m);
  return { m, n: list.length, p1: list.filter((t) => t.priority === "P1").length, neg: list.filter((t) => t.type !== "functional").length };
});
const md = `# Manual test cases — index

Generated by \`node docs/qa/manual/build.mjs\`. Execute in **MANUAL_TEST_CASES.xlsx** (status drop-downs, Summary
formulas, Daily Log) or import **MANUAL_TEST_CASES.csv** into a test-management tool. Do not edit this file by hand.

**${n} cases** · ${cases.filter((t) => t.priority === "P1").length} P1 · ${modules.length} modules · ${roles.length} roles.
Demo data: ${DEMO} Password for every demo login: \`${PW}\`; staff PIN \`1234\`.

| Module | Cases | P1 | Negative / boundary / UI |
|---|---:|---:|---:|
${byMod.map((x) => `| ${x.m} | ${x.n} | ${x.p1} | ${x.neg} |`).join("\n")}
| **Total** | **${n}** | **${byMod.reduce((a, x) => a + x.p1, 0)}** | **${byMod.reduce((a, x) => a + x.neg, 0)}** |

## Cases by role
| Role | Cases |
|---|---:|
${roles.map((r) => `| ${r} | ${cases.filter((t) => t.role === r).length} |`).join("\n")}

## Case list
| TC ID | Module | Role | Pri | Type | What it checks |
|---|---|---|---|---|---|
${cases.map((t) => `| ${t.id} | ${t.module} | ${t.role} | ${t.priority} | ${t.type} | ${t.expected.split(/[.;]/)[0].replaceAll("|", "/").slice(0, 110)} |`).join("\n")}
`;
writeFileSync(join(here, "MANUAL_TEST_CASES.md"), md);

console.log(`cases=${n} modules=${modules.length} roles=${roles.length}`);
for (const x of byMod) console.log(`  ${x.m}: ${x.n}`);
