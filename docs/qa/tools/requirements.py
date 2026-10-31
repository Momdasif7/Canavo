# Single source for the RTM skeleton. Run: python3 docs/qa/tools/requirements.py
# Columns: id, module, requirement, risk, levels, planned test IDs prefix
R = [
 # Auth
 ("AUTH-01","Auth","Login with email + password returns access/refresh tokens; wrong password refused","R4/R10","U,A,E","TC-AUTH"),
 ("AUTH-02","Auth","Login by phone OTP (dev: devCode); OTP expiry and single use","R10","A,M","TC-AUTH"),
 ("AUTH-03","Auth","Staff PIN for attendance clock-in; wrong PIN refused; lockout after repeated failures","R10","A,M","TC-AUTH"),
 ("AUTH-04","Auth","Refresh token rotation; logout invalidates session","R4","A","TC-AUTH"),
 ("AUTH-05","Auth","Token version: role change / password reset / suspension signs user out everywhere","R4","A","TC-AUTH"),
 ("AUTH-06","Auth","Suspended business: all its users refused at login and on existing sessions","R4","A","TC-AUTH"),
 ("AUTH-07","Auth","Brute-force protection on login, OTP and PIN endpoints (rate limit)","R10","A,S","TC-SEC"),
 # RBAC / tenancy
 ("RBAC-01","RBAC","Effective permissions = role permissions ∩ business modules (shared rbac.ts/modules.ts)","R4","U","TC-RBAC"),
 ("RBAC-02","RBAC","Every API route enforces authenticate + requirePermission (+ requireOutlet where outlet-scoped)","R1/R4","SA,A","TC-RBAC"),
 ("RBAC-03","RBAC","Business-owned rows are filtered by businessId for every query (tenant extension)","R1","I,D","TC-ISO"),
 ("RBAC-04","RBAC","Cross-tenant and cross-outlet IDs (IDOR/BOLA) return 404/403 for every route","R1","S","TC-ISO"),
 ("RBAC-05","RBAC","Super Admin has only platform:manage, admin:backup, audit:view and is refused all hotel data","R1/R4","A,S","TC-ISO"),
 ("RBAC-06","RBAC","Account creation chain: SA→Owner; Owner→Manager+staff (no Owner); Manager→staff only","R4","A,S","TC-RBAC"),
 ("RBAC-07","RBAC","Disabled module hides screens and API rejects its routes; module dependencies auto-added","R4","U,A,E","TC-RBAC"),
 # Platform
 ("PLAT-01","Platform","Super Admin onboards a business with owner login and optional first outlet + default tax rates","","A,E","TC-PLAT"),
 ("PLAT-02","Platform","Platform console shows account info only (no sales/staff); summary counts","R1","A,E","TC-PLAT"),
 ("PLAT-03","Platform","Create owner / reset owner password (signs owner out)","R4","A","TC-PLAT"),
 ("PLAT-04","Platform","Suspend / activate business; suspension force-logs out its users","R4","A","TC-PLAT"),
 ("PLAT-05","Platform","Platform audit log shows platform actions only","R1","A","TC-PLAT"),
 ("PLAT-06","Platform","Backups: create/list/restore; no download for Super Admin","R20","A,D","TC-DB"),
 # Outlet / staff / settings
 ("OUT-01","Outlet","Outlet settings: GST registration, composition, GSTIN, invoice prefix, packaging, geofence, dispatch limit, POS photos","R2","A,E","TC-OUT"),
 ("OUT-02","Outlet","Staff CRUD within own outlets; cannot edit self role/status/outlets","R4","A","TC-STAFF"),
 ("OUT-03","Outlet","Staff Aadhaar: encrypted at rest, masked, reveal audited; owner all, manager only staff below in own outlets","R9","U,A,S","TC-SEC"),
 # Menu
 ("MENU-01","Menu","Categories and sub-categories CRUD; delete blocked when items exist","","A,E","TC-MENU"),
 ("MENU-02","Menu","Items with sizes, add-ons, per-outlet overrides, availability window (incl. overnight)","R2","U,A,E","TC-MENU"),
 ("MENU-03","Menu","New items default to GST 0% (business default rate)","R2","A","TC-MENU"),
 ("MENU-04","Menu","Photo upload: magic bytes jpg/png/webp, ≤5 MB; URL host-independent display","R11","A,E","TC-MENU"),
 ("MENU-05","Menu","Excel/CSV bulk upload: template, row preview, errors, update by category+name, sizes, ingredients, apply transaction","R11/R12","A,E","TC-MENU"),
 ("MENU-06","Menu","Custom tax rates (CGST/SGST/IGST/cess/extras), default rate","R2","U,A","TC-TAX"),
 # Billing / GST
 ("BILL-01","Billing","computeBill: GST registered, exclusive/inclusive prices, CGST+SGST vs IGST","R2","U,P","TC-GST"),
 ("BILL-02","Billing","GST off → plain BILL, no tax lines, menu price","R2","U,A","TC-GST"),
 ("BILL-03","Billing","Composition scheme → Bill of Supply, no tax","R2","U,A","TC-GST"),
 ("BILL-04","Billing","Cess and named extra taxes per line","R2","U","TC-GST"),
 ("BILL-05","Billing","Discounts reduce taxable value; manual discount ₹/%","R2","U","TC-GST"),
 ("BILL-06","Billing","Service charge (dine-in), delivery fee, packaging taxed at each line's rate","R2","U","TC-GST"),
 ("BILL-07","Billing","Round to nearest rupee; round-off line","R2","U,P","TC-GST"),
 ("BILL-08","Billing","Server recomputes totals; client totals ignored","R2","A,S","TC-BILL"),
 ("BILL-09","Billing","Order types takeaway / dine-in / delivery / pre-order","","A,E","TC-BILL"),
 ("BILL-10","Billing","Split payments cash/UPI/card/khata sum to total; overpay/underpay rules","R2","A,E","TC-BILL"),
 ("BILL-11","Billing","Invoice number per business per FY, ≤16 chars, no gaps/duplicates; FY rollover 1 Apr IST","R2/R5/R13","U,A,C","TC-BILL"),
 ("BILL-12","Billing","Cancel bill (reason, permission); restores stock, coupon, points, khata","R14","A","TC-BILL"),
 ("BILL-13","Billing","Receipts 58/80 mm text + PDF; public receipt link signed","","A,M","TC-BILL"),
 ("BILL-14","Billing","Offline billing: clientId idempotent sync, no duplicates","R3","A,C,M","TC-BILL"),
 ("BILL-15","Billing","Bill history / filters / bills:view permission","R4","A,E","TC-BILL"),
 # Offers
 ("OFR-01","Offers","Offer types: happy hour, item discount, BxGy, combo, bill discount; time windows in outlet TZ (incl. overnight)","R2/R13","U","TC-OFR"),
 ("OFR-02","Offers","One offer per bill: best saving; tie → higher priority; coupon wins tie","R2","U,A","TC-OFR"),
 ("OFR-03","Offers","BxGy free item suggested/auto-added only when that offer wins","R2","U,A,E","TC-OFR"),
 ("OFR-04","Offers","Coupons: validity window, min order, usage limit, per-customer limit, race-safe redemption","R5","U,A,C","TC-OFR"),
 ("OFR-05","Offers","Loyalty points + manual discount apply on top of the one offer","R2","U,A","TC-OFR"),
 # Kitchen
 ("KOT-01","Kitchen","KOT per kitchen station created with the order (not for running-tab re-bill)","R6","A","TC-KOT"),
 ("KOT-02","Kitchen","KOT status flow PENDING→PREPARING→READY→SERVED; order.ready notification","","A,E","TC-KOT"),
 ("KOT-03","Kitchen","kot:new emitted only after commit; KDS resync on reconnect/wake/15 s; Live indicator","R6","I,RT,E","TC-RT"),
 ("KOT-04","Kitchen","KOT print text; separate 58/80 mm KOT paper width; reprint marked","","U,E","TC-KOT"),
 # Tables
 ("TAB-01","Tables","Floor plan, open tab, rounds fire KOTs, table status","","A,E","TC-TAB"),
 ("TAB-02","Tables","Bill tab full / split; last bill closes tab; split must be atomic","R7","A,C","TC-TAB"),
 # Reservations
 ("RES-01","Reservations","Reservations CRUD; pre-order KOT released before pickup by lead time; cancellation","","A,U","TC-RES"),
 # Delivery
 ("DEL-01","Delivery","Auto-assign to available partner (on duty, at outlet, under limit); prefer partner with 1 order","R15","U,A","TC-DEL"),
 ("DEL-02","Delivery","Limit N per outlet (default 2); 'on a run' lock until delivered + back","R15","A,C","TC-DEL"),
 ("DEL-03","Delivery","Back detection: GPS within geofence+accuracy, clock-in, manager button (409 if orders out)","R15","U,A","TC-DEL"),
 ("DEL-04","Delivery","Waiting queue auto-assigned on return / every minute; managers notified","R15","A","TC-DEL"),
 ("DEL-05","Delivery","Cashier cannot overload partner (409); manager force with warning","R4","A","TC-DEL"),
 ("DEL-06","Delivery","COD: amount to collect, collected → cash in hand = collected − handed over; handover CRUD; FIFO settle","R2","A,D","TC-DEL"),
 ("DEL-07","Delivery","Partner portal: own deliveries only, dashboard, history, activity timeline, clock in/out","R4","A,E","TC-DEL"),
 # Inventory
 ("INV-01","Inventory","Sale deducts recipe; size recipe overrides item recipe; cancel restores","R14","U,A","TC-INV"),
 ("INV-02","Inventory","Negative stock allowed; low-stock alert","R14","A","TC-INV"),
 ("INV-03","Inventory","Purchases update weighted-average cost; vendors; payments","R14","U,A","TC-INV"),
 ("INV-04","Inventory","Audits (count vs snapshot), transfers between outlets, wastage","R14","A","TC-INV"),
 ("INV-05","Inventory","Stock reports for inventory role; food cost/margins owner+manager only","R4","A","TC-INV"),
 # Customers
 ("CUS-01","Customers","Customer by phone; points earn on paid bill, redeem, tiers by spend","R5","U,A","TC-CUS"),
 ("CUS-02","Customers","Khata credit with limit; payments; reversal on cancel","R2/R5","A,C","TC-CUS"),
 # Attendance
 ("ATT-01","Attendance","Clock in/out with GPS geofence + PIN; delivery partners clock out anywhere","","U,A,M","TC-ATT"),
 ("ATT-02","Attendance","Manual attendance by owner/manager for staff below; shifts; late/early/overtime","R4","A","TC-ATT"),
 ("ATT-03","Attendance","Leave and salary sheet","","A","TC-ATT"),
 # Reports
 ("REP-01","Reports","Sales, items, peak hours, GST, GSTR-1, profit, staff, customers, inventory, delivery reports match raw SQL","R2/R13","A,D","TC-REP"),
 ("REP-02","Reports","Excel/PDF exports; formula-injection safe","R12","A,S","TC-REP"),
 ("REP-03","Reports","Scheduled email reports; all-outlets overview","","A","TC-REP"),
 ("REP-04","Reports","Reports only for owner/manager (report:view)","R4","A","TC-REP"),
 # Notifications / realtime
 ("NOT-01","Notifications","Each event creates notification for correct roles/outlet with deep link; push urgent channel","","A,RT","TC-NOT"),
 ("RT-01","Realtime","Socket auth; room scoping by assigned outlet; Super Admin joins no outlet room","R1","RT,S","TC-RT"),
 # Security / ops
 ("SEC-01","Security","Uploads: magic bytes, size cap, no SVG/polyglot, nosniff, path traversal safe","R11","A,S","TC-SEC"),
 ("SEC-02","Security","SSRF-safe bulk-upload image URLs (no internal IPs)","R11","A,S","TC-SEC"),
 ("SEC-03","Security","Security headers (helmet), CORS whitelist, no stack traces in prod","","A,S","TC-SEC"),
 ("SEC-04","Security","Owner data export only own business, no passwords/Aadhaar","R1/R9","A","TC-SEC"),
 ("SEC-05","Security","Razorpay webhook signature, replay, idempotency","R2","A","TC-SEC"),
 ("SEC-06","Security","IP whitelist for Super Admin with lockout protection","","U,A","TC-SEC"),
 ("SEC-07","Security","Production boot refuses missing DATA_ENCRYPTION_KEY / weak secrets; no demo users","R18","U,M","TC-OPS"),
 ("OPS-01","Ops","Health/ready endpoints, graceful shutdown, structured logs, single-instance jobs or locking","R8","A,M","TC-OPS"),
 ("OPS-02","Ops","Migrations apply from empty and from previous state; backup restore drill","R17/R20","D","TC-DB"),
 ("PERF-01","Perf","p95 bill < 500 ms, menu < 300 ms, 1-year report < 3 s, errors < 0.1 % at target load","R16","L","TC-PERF"),
 ("CMP-01","Compliance","GST bill fields, HSN, Bill of Supply wording, GSTR-1 totals; IST business days; DPDP/UIDAI review","R2/R9/R13","C,M","TC-CMP"),
 ("MOB-01","Mobile","Mobile offline queue, permissions, tokens in SecureStore, printing","R3/R19","M,U","TC-MOB"),
 ("UI-01","Web UI","Role journeys, cross-browser, responsive, a11y, double-submit protection, session expiry","","E","TC-E2E"),
]
LEVEL = {"U":"Unit","P":"Property","I":"Integration","A":"API","D":"DB","S":"Security","C":"Concurrency","RT":"Realtime","E":"E2E","L":"Load","M":"Manual","SA":"Static"}
import csv, os
here = os.path.dirname(os.path.abspath(__file__)); qa = os.path.dirname(here)
with open(os.path.join(qa,"RTM.csv"),"w",newline="") as f:
    w = csv.writer(f)
    w.writerow(["Req ID","Module","Requirement / business rule","Risk","Planned levels","Test case IDs","Automated / Manual","Status"])
    for rid,mod,req,risk,lv,tc in R:
        auto = "Manual" if lv=="M" else ("Automated + Manual" if "M" in lv.split(",") else "Automated")
        w.writerow([rid,mod,req,risk,", ".join(LEVEL[x] for x in lv.split(",")),f"{tc}-* (to assign)",auto,"Not started"])
mods = {}
for r in R: mods.setdefault(r[1],0); mods[r[1]] += 1
with open(os.path.join(qa,"RTM.md"),"w") as f:
    f.write("# Requirements Traceability Matrix (RTM)\n\n")
    f.write(f"The full matrix is in [`RTM.csv`](RTM.csv): {len(R)} requirements, each mapped to planned test levels and test-case ID prefixes. It is regenerated from `tools/requirements.py`, and status and test IDs are filled in as each phase runs.\n\n")
    f.write("| Module | Requirements | Status |\n|---|---|---|\n")
    for m,n in mods.items(): f.write(f"| {m} | {n} | Not started |\n")
    f.write(f"| **Total** | **{len(R)}** | |\n\n")
    f.write("Level codes: " + ", ".join(f"{k} = {v}" for k,v in LEVEL.items()) + ".\n\n## Requirements\n\n| Req ID | Module | Requirement | Risk | Levels |\n|---|---|---|---|---|\n")
    for rid,mod,req,risk,lv,tc in R: f.write(f"| {rid} | {mod} | {req} | {risk} | {lv} |\n")
print(len(R),"requirements written")
