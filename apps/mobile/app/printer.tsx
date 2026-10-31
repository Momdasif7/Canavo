import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { charsPerLine } from "@canavo/shared";
import { Screen } from "../src/components/Screen";
import { AppText, Button, Card, Notice, Row, Segmented } from "../src/components/ui";
import { errorMessage } from "../src/lib/api";
import {
  bluetoothPrinter,
  getPrinterPrefs,
  isBluetoothPrintingAvailable,
  printLines,
  savePrinterPrefs,
  type PrinterDevice,
  type PrinterPrefs,
} from "../src/printing";
import { radius, space, TAP, useTheme } from "../src/theme";
import { withAccess } from "../src/auth/RequireAccess";

function testLines(paper: 58 | 80): string[] {
  const w = charsPerLine(paper);
  const rule = "-".repeat(w);
  return ["CANAVO TEST PRINT", rule, `Paper: ${paper}mm (${w} columns)`, new Date().toLocaleString("en-IN"), rule, "1234567890".repeat(5).slice(0, w), rule, "If this fits on one line per row,", "the paper width is correct."];
}

function PrinterSettings() {
  const t = useTheme();
  const bt = isBluetoothPrintingAvailable();
  const [prefs, setPrefs] = useState<PrinterPrefs | null>(null);
  const [devices, setDevices] = useState<PrinterDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    void getPrinterPrefs().then(setPrefs);
  }, []);

  const update = async (p: PrinterPrefs) => {
    setPrefs(p);
    await savePrinterPrefs(p);
  };

  const scan = async () => {
    const printer = bluetoothPrinter();
    if (!printer) return;
    setScanning(true);
    setMessage(null);
    try {
      const found = await printer.scan();
      setDevices(found);
      if (!found.length) setMessage({ kind: "error", text: "No printers found. Pair the printer in Android Bluetooth settings first." });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setScanning(false);
    }
  };

  const connect = async (d: PrinterDevice) => {
    const printer = bluetoothPrinter();
    if (!printer || !prefs) return;
    setConnecting(d.address);
    setMessage(null);
    try {
      await printer.connect(d.address);
      await update({ ...prefs, address: d.address, name: d.name });
      setMessage({ kind: "success", text: `Connected to ${d.name}` });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e, "Could not connect") });
    } finally {
      setConnecting(null);
    }
  };

  const test = async () => {
    if (!prefs) return;
    setPrinting(true);
    setMessage(null);
    try {
      await printLines(testLines(prefs.paper));
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setPrinting(false);
    }
  };

  if (!prefs) return null;

  return (
    <Screen edges={[]}>
      <Card style={{ gap: space.md }}>
        <AppText variant="h3">Bill paper width</AppText>
        <Segmented
          options={[
            { value: "58", label: "58 mm" },
            { value: "80", label: "80 mm" },
          ]}
          value={String(prefs.paper) as "58" | "80"}
          onChange={(v) => update({ ...prefs, paper: v === "80" ? 80 : 58 })}
        />
        <AppText variant="h3">Kitchen ticket (KOT) paper width</AppText>
        <Segmented
          options={[
            { value: "58", label: "58 mm" },
            { value: "80", label: "80 mm" },
          ]}
          value={String(prefs.kotPaper) as "58" | "80"}
          onChange={(v) => update({ ...prefs, kotPaper: v === "80" ? 80 : 58 })}
        />
      </Card>

      {bt ? (
        <Card style={{ gap: space.md }}>
          <AppText variant="h3">Bluetooth thermal printer</AppText>
          <AppText variant="muted">{prefs.name ? `Saved: ${prefs.name}` : "No printer saved — receipts open the system print dialog."}</AppText>
          <Button title="Find printers" icon="bluetooth" variant="secondary" loading={scanning} onPress={scan} />
          {devices.map((d) => {
            const saved = d.address === prefs.address;
            return (
              <Pressable
                key={d.address}
                onPress={() => connect(d)}
                style={[styles.device, { borderColor: saved ? t.primary : t.border, backgroundColor: t.surface }]}
              >
                <Ionicons name="print" size={22} color={saved ? t.primary : t.textMuted} />
                <AppText style={{ flex: 1, fontWeight: "700" }}>{d.name}</AppText>
                <AppText variant="small">{connecting === d.address ? "Connecting…" : saved ? "Saved" : d.address}</AppText>
              </Pressable>
            );
          })}
          {prefs.address ? (
            <Button title="Forget printer" variant="ghost" size="md" onPress={() => update({ ...prefs, address: null, name: null })} />
          ) : null}
        </Card>
      ) : (
        <Notice
          kind="info"
          title="Bluetooth printing needs a development build"
          message="The ESC/POS Bluetooth module is native and isn't included in Expo Go (or on iOS). Receipts are printed through the system print dialog instead. Build the dev client with `eas build --profile development -p android` to print directly to a Bluetooth thermal printer."
        />
      )}

      {message ? <Notice kind={message.kind} message={message.text} /> : null}
      <Row>
        <Button title="Test print" icon="print-outline" loading={printing} onPress={test} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({
  device: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP, paddingHorizontal: space.md, borderWidth: 1.5, borderRadius: radius.md },
});

/** Settings screen: owner, manager and cashier only (`settings:view`). */
export default withAccess(["settings:view"], PrinterSettings);
