import { charsPerLine, formatReceiptText, type PaperWidth } from "@canavo/shared";
import type { Kot, Receipt } from "../lib/types";
import { gstSafeReceipt } from "../pos/localBill";
import { kvGet, kvSet, cacheKeys } from "../lib/db";
import { createBluetoothPrinter, isBluetoothPrintingAvailable } from "./bluetooth";
import { systemPrinter } from "./systemPrint";
import type { ThermalPrinter } from "./ThermalPrinter";

export type { PrinterDevice, ThermalPrinter } from "./ThermalPrinter";
export { isBluetoothPrintingAvailable } from "./bluetooth";

export interface PrinterPrefs {
  /** Bills / receipts */
  paper: PaperWidth;
  /** Kitchen tickets (KOTs) — often a different, narrower kitchen printer roll */
  kotPaper: PaperWidth;
  /** Saved Bluetooth printer */
  address: string | null;
  name: string | null;
}

const DEFAULT_PREFS: PrinterPrefs = { paper: 58, kotPaper: 58, address: null, name: null };

export async function getPrinterPrefs(): Promise<PrinterPrefs> {
  const row = await kvGet<Partial<PrinterPrefs>>(cacheKeys.printer);
  const saved = row?.value ?? {};
  // Prefs saved before the KOT width existed: kitchen tickets keep the receipt width.
  return { ...DEFAULT_PREFS, ...saved, kotPaper: saved.kotPaper ?? saved.paper ?? DEFAULT_PREFS.kotPaper };
}

export const savePrinterPrefs = (p: PrinterPrefs) => kvSet(cacheKeys.printer, p);

let bt: ThermalPrinter | null | undefined;
export function bluetoothPrinter(): ThermalPrinter | null {
  if (bt === undefined) bt = createBluetoothPrinter();
  return bt;
}

/**
 * Print text lines on the best available printer: the saved Bluetooth
 * thermal printer when the native module is present, otherwise the system
 * print dialog. Returns which path was used.
 */
export async function printLines(lines: string[], paper?: PaperWidth): Promise<ThermalPrinter["kind"]> {
  const prefs = await getPrinterPrefs();
  const width = paper ?? prefs.paper;
  const printer = bluetoothPrinter();
  if (printer && prefs.address && isBluetoothPrintingAvailable()) {
    await printer.connect(prefs.address);
    await printer.printLines(lines, width);
    return "bluetooth";
  }
  await systemPrinter.printLines(lines, width);
  return "system";
}

/** Thermal-text lines for a receipt (BILL / tax invoice / bill of supply, cess and extra taxes). */
export function receiptText(receipt: Receipt, paper: PaperWidth): string[] {
  // Non-GST outlet / plain bill: never print tax lines, whatever the stored document says.
  return formatReceiptText(gstSafeReceipt(receipt), paper);
}

export async function printReceipt(receipt: Receipt): Promise<ThermalPrinter["kind"]> {
  const prefs = await getPrinterPrefs();
  return printLines(receiptText(receipt, prefs.paper));
}

/** Wrap `text` to `width` columns, continuation lines indented by `indent`. */
function wrap(text: string, width: number, indent = ""): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) out.push(line);
      line = `${indent}${word}`.slice(0, width);
    }
  }
  if (line) out.push(line);
  return out;
}

/** Thermal-text lines for a kitchen ticket (no prices), laid out for the KOT paper width. */
export function kotText(kot: Kot, paper: PaperWidth): string[] {
  const w = charsPerLine(paper);
  const rule = "-".repeat(w);
  const table = kot.session?.tableLabel ?? kot.order?.tableLabel ?? null;
  const type = kot.session ? "Running tab" : (kot.order?.orderType ?? "").replace(/_/g, " ");
  const lines = [`KOT #${kot.kotNumber}`, `${kot.station.replace(/_/g, " ")} - ${new Date(kot.createdAt).toLocaleString("en-IN")}`];
  if (table) lines.push(`TABLE ${table}`);
  if (type) lines.push(type);
  if (kot.order?.invoiceNumber) lines.push(kot.order.invoiceNumber);
  if (kot.order?.scheduledFor) lines.push(`PRE-ORDER ${new Date(kot.order.scheduledFor).toLocaleString("en-IN")}`);
  lines.push(rule);
  for (const it of kot.items) {
    lines.push(...wrap(`${it.quantity} x ${it.name}${it.voided ? " VOID" : ""}`, w, "    "));
    for (const a of it.addons ?? []) lines.push(...wrap(`  + ${a}`, w, "    "));
    if (it.notes) lines.push(...wrap(`  ! ${it.notes}`, w, "    "));
  }
  if (kot.order?.notes) {
    lines.push(rule);
    lines.push(...wrap(`Note: ${kot.order.notes}`, w));
  }
  lines.push(rule);
  return lines;
}

/** Print a kitchen ticket on the KOT paper width. */
export async function printKot(kot: Kot): Promise<ThermalPrinter["kind"]> {
  const prefs = await getPrinterPrefs();
  return printLines(kotText(kot, prefs.kotPaper), prefs.kotPaper);
}
