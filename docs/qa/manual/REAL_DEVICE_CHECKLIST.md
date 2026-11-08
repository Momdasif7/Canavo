# Real-device checklist (mobile app + mobile web)

Extends the device list in [phase-12-mobile.md § Manual device tests](../phase-12-mobile.md). Install the Expo build
for the release (EAS preview/internal build), sign in with the demo logins (`Canavo@123`). Record each cell as
Pass / Fail (bug ID) / NA.

## Device pool
| ID | Class | Example device | OS | RAM | Notes |
|---|---|---|---|---|---|
| A1 | Android low | Redmi A2 / Samsung Galaxy A03 | Android 10 (Go) / 11 | 2–3 GB | Most canteen counters |
| A2 | Android mid | Samsung Galaxy M14 / Redmi Note 12 | Android 12 / 13 | 4–6 GB | |
| A3 | Android high | Pixel 7 / Galaxy S23 | Android 14 | 8 GB | |
| A4 | Android tablet | Galaxy Tab A8 / Lenovo M10 | Android 12–14 | 3–4 GB | POS / KDS |
| I1 | iPhone (older) | iPhone 11 / SE 2 | iOS 17 | | |
| I2 | iPhone (current) | iPhone 14 / 15 | iOS 18 | | |
| I3 | iPad (optional) | iPad 9th gen | iPadOS 17 / 18 | | |

Android 10, 11, 12, 13 and 14 must each be covered by at least one device.

## Checklist
| # | Area | Check | A1 | A2 | A3 | A4 | I1 | I2 |
|---|---|---|---|---|---|---|---|---|
| 1 | Install | Fresh install, first launch < 5 s (A1 < 8 s), sign in, sign out | | | | | | |
| 2 | Upgrade | Install previous build, create 2 offline bills, upgrade over it → bills still pending and sync | | | | | | |
| 3 | OTP | Login OTP via real SMS; Android autofill / iOS one-time-code suggestion | | | | | | |
| 4 | GPS indoors | Clock in deep inside the kitchen (weak GPS): accuracy shown, accepted inside the 200 m geofence or clear message | | | | | | |
| 5 | Geofence walk | Walk from the outlet door outwards: clock-in allowed at 150 m, refused at 250 m; note the distance the app shows at the boundary | | | | | | |
| 6 | Location permission | Deny / "Only this time" / approximate (iOS) / precise; GPS switched off → clear message each time | | | | | | |
| 7 | Push — foreground | New KOT, order ready, delivery assigned, online order (Urgent channel) arrive | | | | | | |
| 8 | Push — background | App in background 5 min → push arrives, tap opens the right screen | | | | | | |
| 9 | Push — killed | App swiped away → push arrives (Android: also after reboot) | | | | | | |
| 10 | Push — locked / DND | Locked screen shows it; DND behaviour as per channel importance | | | | | | |
| 11 | Push — logout | After logout no pushes reach the device | | | | | | |
| 12 | Android 13+ prompt | Notification permission asked only after sign-in; channels visible in system settings | | | | NA | NA | NA |
| 13 | BT printer pairing | Pair 58 mm and 80 mm ESC/POS printers; test print; re-pair after printer reboot | | | | | NA | NA |
| 14 | 58 mm alignment | Item / qty / amount columns aligned, totals right-aligned, nothing cut off, QR/receipt link prints | | | | | NA | NA |
| 15 | 80 mm alignment | Same on 80 mm; KOT width follows the KOT printer setting | | | | | NA | NA |
| 16 | ₹ symbol | ₹ prints (or falls back to "Rs.") — never "?" or a box | | | | | NA | NA |
| 17 | Indic scripts | Item names in Hindi (मसाला चाय), Kannada (ಮಸಾಲ ದೋಸೆ), Tamil (இட்லி) on screen and on receipt (image/fallback) | | | | | | |
| 18 | iOS printing | System print dialog fallback works (no Bluetooth printing on iOS) | NA | NA | NA | NA | | |
| 19 | Camera | Attendance selfie; barcode scan of 8901262010016 (Milk) in Inventory | | | | | | |
| 20 | Gallery | Pick menu photo from gallery; deny photo permission → message | | | | | | |
| 21 | Low network | Throttle to 2G/EDGE or a weak spot: POS still bills (offline queue), KDS catches up, no duplicate bills | | | | | | |
| 22 | Network switch | Wi-Fi ↔ mobile data on KOT, floor plan, online orders: data catches up without refresh | | | | | | |
| 23 | Airplane mode | 3 cash bills offline → force-stop → relaunch → online → each bill once on the web | | | | | | |
| 24 | Battery saver | Battery saver on: partner location still updates (maybe slower), push still arrives, app not killed in 30 min | | | | | | |
| 25 | Orientation | Portrait ↔ landscape on POS, cart, KDS (tablet landscape default); state kept | | | | | | |
| 26 | Font scale | System font 1.3× and display size large: no clipped buttons | | | | | | |
| 27 | Dark mode | System dark → app dark (and Account → Appearance overrides) | | | | | | |
| 28 | Long shift | 8 h on the POS with 200 bills: no slowdown, memory stable (A1) | | | | | | |
| 29 | Large menu | 500-item menu: open, scroll, search < 1 s | | | | | | |
| 30 | Interruptions | Incoming call / WhatsApp during payment; app resumes on the same screen | | | | | | |
| 31 | Mobile web | Online ordering page + cinema seat page in Chrome / Safari / WhatsApp in-app browser | | | | | | |
| 32 | Biometric | Biometric unlock (if enabled) | | | | | | |

Tester: ________ Date: ______ Build: ______
