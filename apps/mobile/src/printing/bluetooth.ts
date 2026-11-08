import { PermissionsAndroid, Platform } from "react-native";
import type { PaperWidth } from "@canavo/shared";
import type { PrinterDevice, ThermalPrinter } from "./ThermalPrinter";

/**
 * ESC/POS over classic Bluetooth using
 * @vardrz/react-native-bluetooth-escpos-printer — a maintained fork of
 * react-native-bluetooth-escpos-printer with the same JS API (the original
 * 0.0.5 release uses Gradle 3 / `compile` and fails modern Android builds).
 *
 * The module is native: it is NOT in Expo Go. It is required lazily inside
 * try/catch (its index.js dereferences NativeModules at import time and throws
 * when they are missing), so the app degrades to the system print dialog.
 * Build a dev client to use it: `eas build --profile development -p android`.
 */
type BtModule = typeof import("@vardrz/react-native-bluetooth-escpos-printer");

let cached: BtModule | null | undefined;

function loadModule(): BtModule | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require("@vardrz/react-native-bluetooth-escpos-printer") as BtModule;
    cached = mod?.BluetoothManager && mod?.BluetoothEscposPrinter ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function isBluetoothPrintingAvailable(): boolean {
  return Platform.OS === "android" && loadModule() !== null;
}

async function ensurePermissions() {
  if (Platform.OS !== "android") return;
  const perms =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(perms);
  const denied = perms.filter((p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length) throw new Error("Bluetooth permission is needed to find printers");
}

/** The native module returns JSON strings on Android despite its typings. */
function parseDevices(raw: unknown): PrinterDevice[] {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(value)) return [];
  return value
    .map((d) => (typeof d === "string" ? (JSON.parse(d) as unknown) : d))
    .filter((d): d is { name?: string; address: string } => !!d && typeof (d as { address?: unknown }).address === "string")
    .map((d) => ({ name: d.name || d.address, address: d.address }));
}

export function createBluetoothPrinter(): ThermalPrinter | null {
  const mod = loadModule();
  if (!mod || Platform.OS !== "android") return null;
  const { BluetoothManager, BluetoothEscposPrinter } = mod;
  let connectedTo: string | null = null;

  return {
    kind: "bluetooth",
    async scan() {
      await ensurePermissions();
      if (!(await BluetoothManager.isBluetoothEnabled())) await BluetoothManager.enableBluetooth();
      const raw: unknown = await BluetoothManager.scanDevices();
      const res = (typeof raw === "string" ? JSON.parse(raw) : raw) as { paired?: unknown; found?: unknown };
      const all = [...parseDevices(res.paired), ...parseDevices(res.found)];
      return all.filter((d, i) => all.findIndex((x) => x.address === d.address) === i);
    },
    async connect(address) {
      await ensurePermissions();
      if (connectedTo === address) return;
      await BluetoothManager.connect(address);
      connectedTo = address;
    },
    async printLines(lines: string[], _paper: PaperWidth) {
      // Lines are already laid out for the paper width (32 / 48 columns).
      // Control characters are dropped: item names and guest notes (QR orders) must not be able to send
      // ESC/POS commands such as "open the cash drawer" (ESC p) or a paper cut (QA Phase 8, sec1-9).
      // eslint-disable-next-line no-control-regex
      const text = lines.map((l) => l.replace(/₹/g, "Rs").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")).join("\n") + "\n\n\n";
      await BluetoothEscposPrinter.printText(text, { encoding: "UTF-8", codepage: 0 });
      try {
        await BluetoothEscposPrinter.cutPaper();
      } catch {
        // Printers without a cutter reject the command; the text is already out.
      }
    },
  };
}
