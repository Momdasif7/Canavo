# Phase 4 — Unit, property-based & mutation testing: report

| | |
|---|---|
| Date | 2026-11-02 |
| Branch | `qa/full-testing` |
| Status | ✅ Complete. **8 defects found** (1 × P0, 2 × P1, 2 × P2, 3 × P3): **4 fixed and verified**, **4 deferred** for your decision (§6). `packages/shared` at **99.3% statements / 98.6% branches**; mutation score **91.4%** (from 81.3%). |

## 1. Summary

| Target (brief) | Result |
|---|---|
| `packages/shared` ≈ 100% branch coverage | ✅ **98.6% branches, 99.3% statements**. Every logic file (gst, money, invoice, rbac, modules, geo) is at **100 / 100 / 100 / 100**. The 3 uncovered receipt branches are defensive paths that today's inputs can't reach. |
| Services ≥ 85% | ⚠️ **Pure-logic services ≥ 90%**: offer-engine 99.4%, gstr1 100%, razorpay 100%, whatsapp 100%, report-export 92.9%. Services overall, unit + integration combined: **43.4%**. The gap is DB-orchestration code (billing, promotions, delivery, backup, inventory movements), which Phase 5's functional API suites exercise. **The ≥ 85% gate moves to the Phase 5 exit** (honest call: mocking Prisma here would test the mocks, not the code). |
| computeBill: every tax mode, BVA, property-based | ✅ 37 hand-calculated oracles, 15 properties at **100,000 runs each**, BVA from 1 paisa to ₹9.99 crore |
| Offer engine: types, ties, BXGY, coupon vs offer, expiry, limits, happy hours | ✅ Optimality property ("one offer per bill" = best saving, ties → priority), coupon boundaries, BXGY suggestions. The coupon-wins-tie path is DB-bound → Phase 5. |
| rbac.ts truth table | ✅ **229,376** exhaustive role × permission × module-set checks, spec oracle, snapshot. [RBAC_TRUTH_TABLE.md](RBAC_TRUTH_TABLE.md) |
| Invoice numbering, FY rollover 31 Mar → 1 Apr IST | ✅ Boundaries to the millisecond, server-TZ independence, century wrap. **Found BUG-019.** |
| Weighted-average cost, delivery assignment, geofence, loyalty tiers | ✅ Property tests + decision tables (11-row dispatch table, 8-row geofence table) |
| Mutation testing (Stryker) on shared | ✅ **91.4%** overall; survivors analysed (§4) |

**Test counts:** shared 28 → **166**; api unit 104 → **149**; integration 18 → **21**. All green, alongside smoke 24/24, lint (0 errors), typecheck 5/5 and build 3/3.

## 2. New test suites

| File | What | Technique |
|---|---|---|
| `packages/shared/src/gst.property.test.ts` | 12 bill invariants + allocation + order regression + BUG-018 characterization | fast-check, 2,000 runs in CI (`PBT_RUNS` raises it; verified at 100,000) |
| `packages/shared/src/gst.bva.test.ts` | Hand oracles for 0/5/12/18/28%, cess, IGST, inclusive extraction, VAT, composition, GST-off, discounts, SC, delivery/packaging, BVA, helpers, mutation-driven cases | Oracle, BVA, EP |
| `packages/shared/src/invoice.test.ts` | FY boundaries (IST), labels, Rule 46 length, uniqueness property, BUG-019 | BVA, PBT |
| `packages/shared/src/rbac.test.ts` | Spec rules, module dependencies, exhaustive role ∩ module, spec oracle tables, snapshot | Decision table (exhaustive) |
| `packages/shared/src/receipt.test.ts` | Tax lines, Bill of Supply wording, GST-off, COD, wrapping, width property, golden 58/80 mm receipts, ESC/POS bytes | PBT, golden snapshot |
| `packages/shared/src/schemas*.test.ts` | Phone, GSTIN format, FSSAI, prefix, qty 0/1/999/1000, discounts, payments, mass-assignment stripping, offer/coupon/stock/tab/IP refinements | EP, BVA |
| `packages/shared/src/geo.test.ts` | Known distances, 150 m north/east, independent-formula oracle | Oracle, PBT |
| `apps/api/src/services/domain-rules.test.ts` | Dispatch decision table, ranking, geofence, weighted-average cost, offer optimality/safety, coupon BVA, loyalty monotonicity, BXGY suggestions | Decision table, PBT, BVA |
| `apps/api/src/services/adapters.test.ts` | Razorpay QR + webhook HMAC, WhatsApp WATI / wa.me fallbacks (dev fallbacks only, no real credentials) | EP, error guessing |
| `apps/api/test/integration/backdating.test.ts` | BUG-022 evidence | Integration |

Refactor (behaviour-neutral, so the rules can be unit-tested): `partnerStatus()` / `rankAvailablePartners()` extracted from `delivery-assign.ts`, and `withinGeofence()` from `attendance.ts`. `clockSchema` already enforces `accuracy ≥ 0`, so the clamp adds nothing new. Integration and smoke stay green.

## 3. Defects

| ID | Sev | Defect | Found by | Status |
|---|---|---|---|---|
| **BUG-023** | **P0** | UPI QR **pays a placeholder handle** (`canavo@upi`) when Razorpay is off and the outlet has no UPI ID, in production too | Adapter unit tests (error guessing) | ✅ Verified |
| **BUG-019** | **P1** | Invoice number overflows the 16-character limit with a 5-character prefix at the 100,000th bill of a FY, so **billing stops** for that outlet | Invoice BVA vs. schema | ⏸ Decision |
| **BUG-022** | **P1** | Client `createdAt` is accepted on any bill: **backdating into closed FYs**, future bills, expired coupons/happy hours | Offer review → integration repro | ⏸ Decision |
| BUG-017 | P2 | Bill total depends on **item order** (allocation ties broken by position) | Property PBT-GST-006 at 50,000 runs | ✅ Verified |
| BUG-021 | P2 | Money fields unbounded vs `int4` columns → DB 500 instead of 400 | Schema review | ⏸ Phase 6 (cap value) |
| BUG-018 | P3 | A bigger discount can raise the bill (extra charges taxed at the allocated lines' rates near 100% discount) | Property PBT-GST-011 | ⏸ Decision / Phase 14 |
| BUG-020 | P3 | Receipt lines **overflow the paper** (long names) | Property PBT-RCP-001 (after strengthening the generator) | ✅ Verified |
| BUG-024 | P3 | WhatsApp share returns 500 when WATI is unreachable | Adapter tests | ✅ Verified |

### 3.1 BUG-017 — evidence (order dependence)

```
PBT-GST-006 order-independent … Property failed (50,000 runs)
Counterexample: [{unitPrice:4673,qty:320,gst 5%,lineDiscount:99985},{unitPrice:99,qty:369,gst 0%,lineDiscount:16}],
                serviceCharge 10%, Packaging ₹34.04
A,B grand 1655395 tax 76912 | sc 139538 on the 5% line
B,A grand 1655394 tax 76911 | sc 139537 on the 5% line   ← leftover paisa moved by position
```
Fix: `allocate()` breaks ties by weight, then by a canonical line key (`money.ts`, `gst.ts`). After the fix: **PBT-GST-006 passes 100,000 runs**. MUT-GST-001 is red without the fix (`expected 2301 to be 2300`) and green with it.

### 3.2 BUG-018 — evidence (not fixed)

`PBT-GST-011` counterexample: on a ₹1.00 VAT line plus 13 × ₹0.02 at 0% with ₹16.86 packaging, a ₹0.76 discount costs more than a ₹0.03 discount. The whole packaging charge lands on the 14.5% VAT line once the 0% line's taxable value is squeezed to zero. Pinned by characterization test UT-GST-018.

### 3.3 BUG-019 — evidence (not fixed)

`outletSchema` accepts `invoicePrefix: "ABCDE"`. `formatInvoiceNumber("ABCDE", 2026, 100000)` → `"ABCDE-2026-100000"` (17 chars) throws inside `createOrder`'s transaction (`billing.ts:151`). `UT-INV-019` is an `it.fails` test: it passes while the bug exists and will flip when it's fixed.

### 3.4 BUG-020 — note on test strength

The first width property passed 3,000 runs **because fast-check's default size bias kept words short**. A manual probe printed a 55-character line on 32-column paper. The generator now forces 1–90-character words and long names; it failed with a shrunk 33-character word, then passed after the fix.

### 3.5 BUG-022 — evidence (not fixed)

```
✓ ABUSE-BIL-003 evidence: POST /orders {createdAt: "2024-06-01T06:00:00Z"} → 201, invoice INV-2024-…, createdAt 2024-06-01
it.fails ABUSE-BIL-001 (backdated into a closed FY must be 400)   it.fails ABUSE-BIL-002 (future date must be 400)
```

### 3.6 BUG-023 — evidence

`× UT-UPI-002 … promise resolved "{ …(3) }" instead of rejecting` (the QR payload was `upi://pay?pa=canavo@upi&am=50.00…`). Fixed: QR creation now refuses without a UPI ID, and both QR routes now fail the previous pending QR only **after** the new one is created.

## 4. Mutation testing (Stryker 9.3, vitest runner)

| File | Run 1 | Final | Notes |
|---|---|---|---|
| geo.ts | 76.9% | **100%** | Independent-formula oracle + east/west distances |
| modules.ts | **73.7%** | **100%** | See below |
| rbac.ts | 98.8% | 98.8% | 1 "survivor" is a Stryker false survivor (verified killed by hand) |
| invoice.ts | 97.1% | 97.1% | 1 equivalent mutant (`find(year)` → first part, which is the year anyway) |
| gst.ts | 90.2% | **95.3%** | Remaining: tie-key field mutations (equivalent unless two lines differ only in cess/extras/line discount) and breakup-key separator |
| money.ts | 91.4% | 91.4% | Remaining are false survivors or equivalent (default tie key constant) |
| receipt.ts | 63.3% | **79.5%** | Remaining are whitespace/centering details (golden snapshots catch layout changes) |
| **All** | **81.3%** | **91.4%** | Exit criterion EX-4 (≥ 80%) met |

**Most important finding:** in `modules.ts` the mutants `PERMISSION_MODULE = {}` and `requires: ["BILLING"] → []` **survived**. With those mutations, **switching a module off would no longer remove any feature**, and no test noticed. The earlier tests derived their expected values from those same tables, so they could never disagree with them. They are now checked against an independent spec table (UT-MOD-SPEC-001..004).

**Tool caveat:** Stryker's vitest runner reported several mutants as survived that are killed when applied by hand. I wrote a small manual mutant runner and re-checked 7 survivors: **6 killed** (false survivors) and **1 real gap** (breakup grouping ignored extra taxes, now covered by MUT-GST-006). Reproduce with `npm run test:mutation -w @canavo/shared`.

## 5. Other observations (logged for later phases)

| Ref | Observation | Phase |
|---|---|---|
| SA-DOC-02 | README describes **stacking** promotions (item offers + bill offer + coupon + points). The code implements **one offer per bill** (best saving; coupon wins ties), plus points and the manual discount. | Doc fix (16) |
| CMP-01 | Tax invoices print **no place of supply** and **no HSN codes** per item | 14 |
| CMP-02 | GSTIN is validated by format only, with no checksum and any 2-digit state code | 14 |
| SEC-PW | Password policy is length ≥ 8 only | 8 |
| SEC-URL | `menuItemSchema.imageUrl` uses `z.string().url()`, which accepts `javascript:` / internal URLs | 8 |
| SEC-IP | `0.0.0.0/0` is accepted in the IP whitelist (effectively disables it); the IPv6 regex is permissive | 8 |
| GEO-01 | Clock-in geofence trusts the client's lat/lng **and** its claimed accuracy (+100 m max) | 8 / manual |
| INC-01 | With round-off **off**, a tax-inclusive bill is ±1 paisa from the menu price for ~22% of bills (50,000-run probe) | Info |

## 6. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D-6 | **BUG-019** invoice format: (a) max prefix 4 chars, (b) `INV/26/000001` (2-digit FY), (c) other | (a): smallest change, keeps the documented format |
| D-7 | **BUG-022** offline window for client `createdAt` | Only via `/orders/sync`, ≤ 5 min in the future, ≤ 72 h old, never in a closed FY |
| D-8 | **BUG-018** tax on packaging/delivery: proportional (today) vs principal-supply rate | Principal-supply rate (GST composite-supply rule); revisit in Phase 14 |
| D-9 | **BUG-021** business cap on a single item price | ₹10,00,000 per unit, plus the int4 technical cap on totals |
| — | Still open from earlier: BUG-003, D-1 (BUG-013 socket rooms), D-2 … D-5 | |

## 7. RTM delta

Pass 24 → **42**, Partial 23 → **30**, Fail 4 → **5** (BIL-009 now Fail on BUG-019). Requirements with ≥ 1 passing test: **72 / 200**.

## 8. Commands

```bash
npm test                                          # all unit suites (shared 166, api 149)
npm run test:coverage -w @canavo/shared           # coverage table
npm run test:mutation -w @canavo/shared           # Stryker (≈ 6 min)
PBT_RUNS=100000 npx vitest run src/gst.property.test.ts --testTimeout=900000   # deep property run (in packages/shared)
npm run test:integration -w @canavo/api           # needs Docker Postgres
```
