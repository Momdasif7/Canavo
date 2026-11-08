# Negative chaos tests (manual)

Physical-world failures that automation (Phase 9 concurrency, Phase 10 real-time) cannot reproduce. Use staging,
demo data, a router you control and spare devices. After every test run the **oracle**: Bills list, KDS, cash drawer,
khata and stock agree, with **no lost, duplicated or half-written bill** and continuous invoice numbers.

| # | Scenario | Steps | Expected | Result |
|---|---|---|---|---|
| X1 | Network pulled mid-payment (cash) | Web POS: add items → Pay → unplug Ethernet / Wi-Fi off just as you click Confirm | Bill saved offline (pending) or clearly failed — never "paid" twice after reconnect; one bill on the server | |
| X2 | Network pulled mid-payment (UPI) | Show UPI QR; customer pays; cut the POS network for 2 min | After reconnect the bill shows paid (webhook reached the server); no second QR / payment | |
| X3 | Power off mid-bill | Unplug the POS PC / pull the tablet battery while the cart has 5 items; power on | Cart lost or restored (note which); no half bill on the server; held bills survive | |
| X4 | Power off after pay, before print | Pay → cut power before the receipt prints | Bill exists; reprint from Bills works | |
| X5 | Router reboot during rush | 2 cashiers billing; reboot the router | Offline mode on both; all bills sync once; KDS catches up | |
| X6 | Same user on two devices | cashier@ signed in on laptop and phone; bill on both at once; edit the same held bill | Both bills saved; invoice numbers unique; no cart cross-talk | |
| X7 | Same table on two devices | Two waiters add to T4 at the same second | Both items present once | |
| X8 | Wrong system clock (+1 day / −2 h) | Set the POS device clock wrong; bill online and offline | Server time (IST) used for online bills; offline bills get a sensible time on sync; happy hour follows server time; FY numbering correct | |
| X9 | Wrong time zone | Device in UTC / America/New_York | Receipts and reports in IST | |
| X10 | Session expired mid-bill | Leave POS idle past token expiry; then pay | Silent refresh or re-login without losing the cart | |
| X11 | Role changed while signed in | Owner changes the cashier to Waiter during a shift | Cashier signed out / loses POS within a minute; no bill half-made | |
| X12 | Module switched off mid-use | Super Admin turns DELIVERY off while a cashier is on the delivery board | Screen shows not available; data safe; turning on restores | |
| X13 | Business suspended mid-shift | Super Admin suspends Demo Hotel | All users signed out; offline queue kept and synced after reactivation (or clearly reported) | |
| X14 | API restart | Restart the API during billing | Short reconnect; no lost bill; sockets reconnect, KDS resyncs | |
| X15 | Database failover / slow DB | Throttle DB (ask DevOps) | Requests slow but correct; no duplicate bill from retries | |
| X16 | Printer dies mid-rush | Turn off the printer during 10 quick bills | Bills saved; clear printer error; reprint queue works | |
| X17 | Phone storage full | Fill the phone; bill offline | Clear error or still saved; no silent loss | |
| X18 | Kill app during sync | 5 pending offline bills; kill the app while syncing | After relaunch, each bill on the server once | |
| X19 | Double submit | Double-click Pay, press Enter twice, tap Place order twice on the online page | One bill / one order | |
| X20 | Browser back / refresh during payment | Refresh the page while the UPI dialog is open | Bill pending, QR re-openable, not duplicated | |

Tester: ________ Date: ______ Build: ______
