# Hardware checklist

Hardware is out of scope for automation ([TEST_STRATEGY §2.2](../TEST_STRATEGY.md)). Record make/model/firmware for each
device. Printers: at least one 58 mm and one 80 mm ESC/POS (USB/LAN on web via the print setup, Bluetooth on Android).

## Thermal printer
| # | Check | 58 mm | 80 mm | Notes |
|---|---|---|---|---|
| H1 | Setup: Settings → printer; test print | | | |
| H2 | Receipt layout: header, GSTIN, FSSAI, HSN/SAC line, place of supply, tax table, total, footer; nothing truncated | | | |
| H3 | ₹ symbol and an Indic item name print (or fallback "Rs.") | | | |
| H4 | 60-character item name wraps; amounts stay right-aligned | | | |
| H5 | KOT on the kitchen printer: large item names, notes, table / seat bar, REPRINT mark | | | |
| H6 | **Paper out** mid-receipt → clear error on the POS; bill still saved; reprint after loading paper | | | |
| H7 | **Cover open** → error, no crash; print resumes after closing | | | |
| H8 | **Disconnect** (power off / unplug / out of BT range) mid-shift → error, billing continues, reconnect without app restart | | | |
| H9 | No auto-cutter model: receipts separated with feed lines | | | |
| H10 | Guest note with control characters prints as text (no garbage, no cutter firing) | | | |
| H11 | 50 receipts in a row (rush): no skipped prints, no out-of-order | | | |
| H12 | Two printers (receipt + KOT) on one outlet: each job goes to the right one | | | |

## Cash drawer (via printer RJ11 kick)
| # | Check | Result |
|---|---|---|
| D1 | Drawer opens on a cash payment | |
| D2 | Does **not** open on UPI / card / khata bills | |
| D3 | "Open drawer" without sale (if offered) is permission-gated and logged | |
| D4 | Printer off → cash bill still saved; drawer can be opened by key | |
| D5 | Cash drawer screen: open float, cash sales, close count, difference | |

## Barcode scanner (USB HID / Bluetooth)
| # | Check | Result |
|---|---|---|
| B1 | In Inventory → Stock search, scan 8901262010016 → Milk (toned) | |
| B2 | Scan into POS search (if barcodes on menu items) adds the item | |
| B3 | Scanner suffix Enter does not submit a wrong form | |
| B4 | Unknown barcode → "not found", no crash | |
| B5 | Phone camera scan in the mobile app (same codes) | |

## KDS wall display
| # | Check | Result |
|---|---|---|
| K1 | 32"–43" TV / monitor with a mini-PC or Android TV browser, 1920×1080, kiosk/full-screen | |
| K2 | Readable from 3 m: item names, qty, table/token, age colours | |
| K3 | New ticket sound audible in a noisy kitchen | |
| K4 | Runs 8 h: no memory growth, still live (Live indicator), resync after Wi-Fi drop | |
| K5 | Screen saver / sleep disabled; after TV wake, tickets resync within 15 s | |
| K6 | Touch TV (if used): Start / Ready buttons large enough | |
| K7 | Cinema Runner board on the same display: screen tabs and interval timer readable | |

Tester: ________ Date: ______ Build: ______
