import * as Print from "expo-print";
import type { PaperWidth } from "@canavo/shared";
import type { ThermalPrinter } from "./ThermalPrinter";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Receipt as HTML: the thermal text in a monospace <pre> at roll width. */
export function receiptHtml(lines: string[], paper: PaperWidth): string {
  const widthMm = paper === 58 ? 58 : 80;
  const fontPt = paper === 58 ? 8.5 : 9;
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  @page { size: ${widthMm}mm auto; margin: 2mm; }
  body { margin: 0; }
  pre { font-family: "Courier New", Courier, monospace; font-size: ${fontPt}pt; line-height: 1.25;
        width: ${widthMm - 4}mm; white-space: pre; margin: 0; }
</style></head><body><pre>${escape(lines.join("\n"))}</pre></body></html>`;
}

/** Fallback printer: the OS print dialog (works in Expo Go, iOS and with Wi-Fi/IPP printers). */
export const systemPrinter: ThermalPrinter = {
  kind: "system",
  async scan() {
    return [];
  },
  async connect() {
    // The OS dialog picks the printer.
  },
  async printLines(lines, paper) {
    await Print.printAsync({ html: receiptHtml(lines, paper) });
  },
};
