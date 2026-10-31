import type { PaperWidth } from "@canavo/shared";

export interface PrinterDevice {
  name: string;
  address: string;
}

/**
 * A receipt printer. `bluetooth` drives an ESC/POS thermal printer directly;
 * `system` hands a monospace receipt to the OS print dialog (expo-print) and
 * is the fallback where the native Bluetooth module isn't available
 * (Expo Go, iOS, web).
 */
export interface ThermalPrinter {
  readonly kind: "bluetooth" | "system";
  /** Discover printers (paired + nearby). The system printer returns []. */
  scan(): Promise<PrinterDevice[]>;
  connect(address: string): Promise<void>;
  /** Print pre-formatted lines (see formatReceiptText) on 58mm or 80mm paper. */
  printLines(lines: string[], paper: PaperWidth): Promise<void>;
}
