-- =====================================================================================
-- CANAVO — data reconciliation queries (QA Phase 7, database testing)
--
-- Every query below returns ZERO ROWS when the books are right. Each returned row names
-- the record that is out of line and the two numbers that disagree.
--
-- How to run (read-only, across every hotel — row-level security bypassed for this session):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "BEGIN READ ONLY" -c "SELECT set_config('app.bypass_rls','on',true)" -f docs/qa/sql/reconciliation.sql -c "ROLLBACK"
-- or paste into a session that ran:
--   BEGIN READ ONLY; SELECT set_config('app.bypass_rls', 'on', true);
--
-- Format contract (apps/api/test/db/reconciliation.test.ts parses this file):
--   * each query starts with a line "-- @check <ID> <slug>" or "-- @warn <ID> <slug>";
--   * the query text runs to the next "-- @check"/"-- @warn" marker and ends with ";";
--   * no other semicolons inside a query.
--   @check = must be empty (a non-empty result is a defect).
--   @warn  = allowed by a documented business rule, but worth a look (reported, not failed).
--
-- Conventions: money is integer paise; stock quantities are floats rounded to 3 decimals
-- (compared with a 0.0005 tolerance); timestamps are UTC "timestamp(3)" columns, local days
-- use the outlet's timezone.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- A. Bills and payments
-- -------------------------------------------------------------------------------------

-- @check A01 paid_bill_payments_equal_grand_total
-- A PAID bill: the successful payments (every mode: cash, UPI, card, khata, gift card,
-- company share, wallet, meal tokens, paid online, COD collected at the door) add up to
-- exactly the grand total. Tips are a separate column (Payment.tip) and are NOT part of
-- the amount. Refunds never edit payments: they are credit notes (checked in A04).
SELECT o.id, o."outletId", o."invoiceNumber", o."grandTotal",
       COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0) AS paid
FROM "Order" o
LEFT JOIN "Payment" p ON p."orderId" = o.id
WHERE o.status = 'PAID'
GROUP BY o.id
HAVING COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0) <> o."grandTotal";

-- @check A02 no_bill_overpaid
-- No bill (open, paid or cancelled) ever has more successful payments than its grand total.
SELECT o.id, o."outletId", o."invoiceNumber", o.status, o."grandTotal", SUM(p.amount) AS paid
FROM "Order" o
JOIN "Payment" p ON p."orderId" = o.id AND p.status = 'SUCCESS'
GROUP BY o.id
HAVING SUM(p.amount) > o."grandTotal";

-- @check A03 open_bill_not_fully_paid
-- An OPEN bill whose successful payments already cover a non-zero total should have been
-- marked PAID (settleIfPaid runs in the same transaction as every payment).
SELECT o.id, o."outletId", o."invoiceNumber", o."grandTotal", SUM(p.amount) AS paid
FROM "Order" o
JOIN "Payment" p ON p."orderId" = o.id AND p.status = 'SUCCESS'
WHERE o.status = 'OPEN' AND o."grandTotal" > 0
GROUP BY o.id
HAVING SUM(p.amount) >= o."grandTotal";

-- @check A04 refunded_amount_equals_credit_notes
-- Order.refundedAmount is the sum of its credit notes, never more than the grand total, and
-- credit notes exist only on PAID bills (a refunded bill can't be cancelled afterwards).
SELECT o.id, o."outletId", o."invoiceNumber", o.status, o."grandTotal", o."refundedAmount",
       COALESCE(SUM(cn.amount), 0) AS credit_notes
FROM "Order" o
LEFT JOIN "CreditNote" cn ON cn."orderId" = o.id
GROUP BY o.id
HAVING o."refundedAmount" <> COALESCE(SUM(cn.amount), 0)
    OR o."refundedAmount" > o."grandTotal"
    OR (COUNT(cn.id) > 0 AND o.status <> 'PAID');

-- @check A05 status_timestamps
-- PAID bills carry paidAt, CANCELLED bills carry cancelledAt, OPEN bills carry neither.
SELECT id, "outletId", "invoiceNumber", status, "paidAt", "cancelledAt"
FROM "Order"
WHERE (status = 'PAID' AND "paidAt" IS NULL)
   OR (status = 'CANCELLED' AND "cancelledAt" IS NULL)
   OR (status = 'OPEN' AND ("paidAt" IS NOT NULL OR "cancelledAt" IS NOT NULL));

-- @check A06 bill_arithmetic
-- grandTotal = taxable value + service charge + extra charges + every tax + round-off; the
-- bill's tax columns equal the sum of its lines; the lines' totals add up to the grand total
-- before round-off; every bill has at least one line.
SELECT o.id, o."outletId", o."invoiceNumber", o."grandTotal",
       o."taxableValue" + o."serviceCharge" + o."extraCharges" + o.cgst + o.sgst + o.igst + o.cess + o."otherTaxes" + o."roundOff" AS recomputed,
       COUNT(i.id) AS lines, COALESCE(SUM(i.total), 0) AS line_totals
FROM "Order" o
LEFT JOIN "OrderItem" i ON i."orderId" = o.id
GROUP BY o.id
HAVING COUNT(i.id) = 0
    OR o."grandTotal" <> o."taxableValue" + o."serviceCharge" + o."extraCharges" + o.cgst + o.sgst + o.igst + o.cess + o."otherTaxes" + o."roundOff"
    OR o."taxableValue" <> SUM(i."taxableValue")
    OR o."serviceCharge" <> SUM(i."serviceCharge")
    OR o.cgst <> SUM(i.cgst) OR o.sgst <> SUM(i.sgst) OR o.igst <> SUM(i.igst)
    OR o.cess <> SUM(i.cess) OR o."otherTaxes" <> SUM(i."otherTaxes")
    OR SUM(i.total) <> o."grandTotal" - o."roundOff";

-- @check A07 khata_payments_have_ledger
-- Every rupee put on khata by a payment is a DEBIT on the customer's khata ledger for that
-- bill (and no DEBIT exists without the payment).
WITH pay AS (
  SELECT "orderId", SUM(amount) AS amt FROM "Payment" WHERE mode = 'KHATA' AND status = 'SUCCESS' GROUP BY "orderId"
), led AS (
  SELECT "orderId", SUM(amount) AS amt FROM "KhataTransaction" WHERE type = 'DEBIT' AND "orderId" IS NOT NULL GROUP BY "orderId"
)
SELECT COALESCE(pay."orderId", led."orderId") AS order_id, pay.amt AS khata_payments, led.amt AS khata_debits
FROM pay FULL JOIN led ON led."orderId" = pay."orderId"
WHERE COALESCE(pay.amt, 0) <> COALESCE(led.amt, 0);

-- @check A08 gift_card_payments_have_ledger
-- A GIFT_CARD payment names its card and is matched by a REDEEM row of the same amount on the
-- card's ledger for that bill.
WITH pay AS (
  SELECT "orderId", SUM(amount) AS amt, COUNT(*) FILTER (WHERE "giftCardId" IS NULL) AS no_card
  FROM "Payment" WHERE mode = 'GIFT_CARD' AND status = 'SUCCESS' GROUP BY "orderId"
), led AS (
  SELECT "orderId", -SUM(amount) AS amt FROM "GiftCardTxn" WHERE type = 'REDEEM' AND "orderId" IS NOT NULL GROUP BY "orderId"
)
SELECT COALESCE(pay."orderId", led."orderId") AS order_id, pay.amt AS gift_card_payments, led.amt AS redeemed, pay.no_card
FROM pay FULL JOIN led ON led."orderId" = pay."orderId"
WHERE COALESCE(pay.amt, 0) <> COALESCE(led.amt, 0) OR COALESCE(pay.no_card, 0) > 0;

-- @check A09 wallet_and_token_payments_have_ledger
-- Canteen: WALLET payments = SPEND rows on the member's wallet ledger for the bill; MEAL_TOKEN
-- payments' token count = tokens redeemed (REDEEM rows) for the bill; a CORPORATE (company
-- share) payment names its company.
WITH wp AS (
  SELECT "orderId", SUM(amount) AS amt FROM "Payment" WHERE mode = 'WALLET' AND status = 'SUCCESS' GROUP BY "orderId"
), wl AS (
  SELECT "orderId", -SUM(amount) AS amt FROM "WalletTxn" WHERE type = 'SPEND' AND "orderId" IS NOT NULL GROUP BY "orderId"
), tp AS (
  SELECT "orderId", SUM(COALESCE(tokens, 1)) AS n FROM "Payment" WHERE mode = 'MEAL_TOKEN' AND status = 'SUCCESS' GROUP BY "orderId"
), tl AS (
  SELECT "orderId", -SUM(count) AS n FROM "MealTokenTxn" WHERE type = 'REDEEM' AND "orderId" IS NOT NULL GROUP BY "orderId"
)
SELECT 'wallet' AS kind, COALESCE(wp."orderId", wl."orderId") AS order_id, wp.amt AS payments, wl.amt AS ledger
FROM wp FULL JOIN wl ON wl."orderId" = wp."orderId" WHERE COALESCE(wp.amt, 0) <> COALESCE(wl.amt, 0)
UNION ALL
SELECT 'meal_tokens', COALESCE(tp."orderId", tl."orderId"), tp.n, tl.n
FROM tp FULL JOIN tl ON tl."orderId" = tp."orderId" WHERE COALESCE(tp.n, 0) <> COALESCE(tl.n, 0)
UNION ALL
SELECT 'corporate_without_company', "orderId", amount, NULL FROM "Payment"
WHERE mode = 'CORPORATE' AND status = 'SUCCESS' AND "corporateAccountId" IS NULL;

-- @check A10 refunds_reach_their_ledger
-- A credit note paid back to khata / gift card / wallet is a CREDIT / REFUND row on that
-- ledger for the bill. A cancelled bill additionally gives back everything it took from gift
-- cards and wallets (the cancel REFUND rows), so for each bill:
--   gift card REFUND rows = gift-card credit notes + (cancelled ? gift-card payments : 0)
--   wallet REFUND rows    = wallet credit notes    + (cancelled ? wallet payments    : 0)
--   khata CREDIT 'REFUND' = khata credit notes
WITH o AS (SELECT id, status FROM "Order"),
cn AS (SELECT "orderId", "refundMode", SUM(amount) AS amt FROM "CreditNote" GROUP BY "orderId", "refundMode"),
pay AS (SELECT "orderId", mode, SUM(amount) AS amt FROM "Payment" WHERE status = 'SUCCESS' GROUP BY "orderId", mode),
gc AS (SELECT "orderId", SUM(amount) AS amt FROM "GiftCardTxn" WHERE type = 'REFUND' AND "orderId" IS NOT NULL GROUP BY "orderId"),
wa AS (SELECT "orderId", SUM(amount) AS amt FROM "WalletTxn" WHERE type = 'REFUND' AND "orderId" IS NOT NULL GROUP BY "orderId"),
kh AS (SELECT "orderId", SUM(amount) AS amt FROM "KhataTransaction" WHERE type = 'CREDIT' AND mode = 'REFUND' AND "orderId" IS NOT NULL GROUP BY "orderId"),
want AS (
  SELECT o.id, o.status,
    COALESCE((SELECT amt FROM cn WHERE cn."orderId" = o.id AND cn."refundMode" = 'GIFT_CARD'), 0)
      + CASE WHEN o.status = 'CANCELLED' THEN COALESCE((SELECT amt FROM pay WHERE pay."orderId" = o.id AND pay.mode = 'GIFT_CARD'), 0) ELSE 0 END AS gc_want,
    COALESCE((SELECT amt FROM gc WHERE gc."orderId" = o.id), 0) AS gc_have,
    COALESCE((SELECT amt FROM cn WHERE cn."orderId" = o.id AND cn."refundMode" = 'WALLET'), 0)
      + CASE WHEN o.status = 'CANCELLED' THEN COALESCE((SELECT amt FROM pay WHERE pay."orderId" = o.id AND pay.mode = 'WALLET'), 0) ELSE 0 END AS wa_want,
    COALESCE((SELECT amt FROM wa WHERE wa."orderId" = o.id), 0) AS wa_have,
    COALESCE((SELECT amt FROM cn WHERE cn."orderId" = o.id AND cn."refundMode" = 'KHATA'), 0) AS kh_want,
    COALESCE((SELECT amt FROM kh WHERE kh."orderId" = o.id), 0) AS kh_have
  FROM o
)
SELECT * FROM want WHERE gc_want <> gc_have OR wa_want <> wa_have OR kh_want <> kh_have;

-- @check A11 cancelled_bills_fully_unwound
-- A cancelled bill leaves nothing behind: its khata debits are fully credited back, redeemed
-- loyalty points are returned, meal tokens restored, coupon use released, and every
-- ingredient it deducted is put back (SALE + SALE_REVERSAL = 0 per item).
-- (Earned points are taken back only as far as the customer still has them — the rest is
-- noted on the ledger as "already used"; that shortfall is not checked here.)
WITH c AS (SELECT id, "invoiceNumber" FROM "Order" WHERE status = 'CANCELLED')
SELECT 'khata' AS what, c.id, c."invoiceNumber", SUM(CASE WHEN k.type = 'DEBIT' THEN k.amount ELSE -k.amount END) AS left_over
FROM c JOIN "KhataTransaction" k ON k."orderId" = c.id GROUP BY c.id, c."invoiceNumber"
HAVING SUM(CASE WHEN k.type = 'DEBIT' THEN k.amount ELSE -k.amount END) <> 0
UNION ALL
SELECT 'points_redeemed', c.id, c."invoiceNumber", SUM(l.points)
FROM c JOIN "LoyaltyTransaction" l ON l."orderId" = c.id AND (l.type = 'REDEEM' OR (l.type = 'REVERSE' AND l.points > 0))
GROUP BY c.id, c."invoiceNumber" HAVING SUM(l.points) <> 0
UNION ALL
SELECT 'meal_tokens', c.id, c."invoiceNumber", SUM(t.count)
FROM c JOIN "MealTokenTxn" t ON t."orderId" = c.id GROUP BY c.id, c."invoiceNumber" HAVING SUM(t.count) <> 0
UNION ALL
SELECT 'coupon', c.id, c."invoiceNumber", COUNT(*) FROM c JOIN "CouponRedemption" r ON r."orderId" = c.id GROUP BY c.id, c."invoiceNumber"
UNION ALL
SELECT 'stock:' || t."inventoryItemId", c.id, c."invoiceNumber", ROUND(SUM(t.quantity)::numeric, 3)
FROM c JOIN "InventoryTransaction" t ON t."refType" = 'Order' AND t."refId" = c.id AND t.type IN ('SALE', 'SALE_REVERSAL')
GROUP BY c.id, c."invoiceNumber", t."inventoryItemId" HAVING ABS(SUM(t.quantity)) > 0.0005;

-- @check A12 loyalty_earn_once_and_only_when_paid
-- Points are earned once per bill, and only on a bill that was paid (an OPEN bill never has
-- an EARN row; a cancelled one may, together with its REVERSE).
SELECT l."orderId", o.status, COUNT(*) AS earn_rows
FROM "LoyaltyTransaction" l JOIN "Order" o ON o.id = l."orderId"
WHERE l.type = 'EARN'
GROUP BY l."orderId", o.status
HAVING COUNT(*) > 1 OR o.status = 'OPEN';


-- -------------------------------------------------------------------------------------
-- B. Stored balances = their ledgers
-- -------------------------------------------------------------------------------------

-- @check B01 loyalty_points_equal_ledger
SELECT c.id, c."businessId", c.phone, c.points, COALESCE(SUM(l.points), 0) AS ledger
FROM "Customer" c LEFT JOIN "LoyaltyTransaction" l ON l."customerId" = c.id
GROUP BY c.id
HAVING c.points <> COALESCE(SUM(l.points), 0) OR c.points < 0;

-- @check B02 khata_balance_equals_ledger
-- khataBalance = Σ DEBIT − Σ CREDIT (bills on credit − settlements, refunds and cancellations).
SELECT c.id, c."businessId", c.phone, c."khataBalance",
       COALESCE(SUM(CASE WHEN k.type = 'DEBIT' THEN k.amount ELSE -k.amount END), 0) AS ledger
FROM "Customer" c LEFT JOIN "KhataTransaction" k ON k."customerId" = c.id
GROUP BY c.id
HAVING c."khataBalance" <> COALESCE(SUM(CASE WHEN k.type = 'DEBIT' THEN k.amount ELSE -k.amount END), 0);

-- @warn B03 khata_balance_negative
-- The shop owes the customer (e.g. a khata refund after the customer had settled). Allowed
-- but unusual: a settlement can never exceed the balance, so this needs a look.
SELECT id, "businessId", phone, "khataBalance" FROM "Customer" WHERE "khataBalance" < 0;

-- @check B04 gift_card_balance_equals_ledger
-- balance = Σ GiftCardTxn.amount (ISSUE +, REDEEM −, REFUND +, ADJUST ±), never negative, and
-- each card has exactly one ISSUE row worth its initial value.
SELECT g.id, g."businessId", g.code, g.balance, g."initialValue",
       COALESCE(SUM(t.amount), 0) AS ledger,
       COUNT(*) FILTER (WHERE t.type = 'ISSUE') AS issue_rows,
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'ISSUE'), 0) AS issued
FROM "GiftCard" g LEFT JOIN "GiftCardTxn" t ON t."giftCardId" = g.id
GROUP BY g.id
HAVING g.balance <> COALESCE(SUM(t.amount), 0) OR g.balance < 0
    OR COUNT(*) FILTER (WHERE t.type = 'ISSUE') <> 1
    OR COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'ISSUE'), 0) <> g."initialValue";

-- @check B05 canteen_wallet_balance_equals_ledger
SELECT c.id, c."businessId", c.phone, c."walletBalance", COALESCE(SUM(w.amount), 0) AS ledger
FROM "Customer" c LEFT JOIN "WalletTxn" w ON w."customerId" = c.id
GROUP BY c.id
HAVING c."walletBalance" <> COALESCE(SUM(w.amount), 0) OR c."walletBalance" < 0;

-- @check B06 meal_token_accounts_equal_ledger
SELECT a.id, a."customerId", a.balance, a.value, COALESCE(SUM(t.count), 0) AS ledger_count, COALESCE(SUM(t.amount), 0) AS ledger_value
FROM "MealTokenAccount" a LEFT JOIN "MealTokenTxn" t ON t."accountId" = a.id
GROUP BY a.id
HAVING a.balance <> COALESCE(SUM(t.count), 0) OR a.value <> COALESCE(SUM(t.amount), 0) OR a.balance < 0 OR a.value < 0;

-- @check B07 coupon_used_count_equals_redemptions
SELECT c.id, c."businessId", c.code, c."usedCount", COUNT(r.id) AS redemptions
FROM "Coupon" c LEFT JOIN "CouponRedemption" r ON r."couponId" = c.id
GROUP BY c.id
HAVING c."usedCount" <> COUNT(r.id) OR (c."usageLimit" IS NOT NULL AND COUNT(r.id) > c."usageLimit");

-- @check B08 purchase_paid_amount_equals_payments
SELECT p.id, p."outletId", p.total, p."paidAmount", COALESCE(SUM(pp.amount), 0) AS payments
FROM "Purchase" p LEFT JOIN "PurchasePayment" pp ON pp."purchaseId" = p.id
GROUP BY p.id
HAVING p."paidAmount" <> COALESCE(SUM(pp.amount), 0) OR p."paidAmount" > p.total;


-- -------------------------------------------------------------------------------------
-- C. Inventory: stock = opening + purchases − sales (recipes) − wastage ± transfers ± audits
--    ± adjustments − returns + sale reversals. Every change goes through the ledger
--    (InventoryTransaction), so per item per outlet the stored quantity is the ledger's sum.
-- -------------------------------------------------------------------------------------

-- @check C01 stock_equals_ledger
SELECT COALESCE(s."outletId", l."outletId") AS outlet_id, COALESCE(s."inventoryItemId", l."inventoryItemId") AS item_id,
       s.quantity AS stored, l.qty AS ledger, l.by_type
FROM "InventoryStock" s
FULL JOIN (
  SELECT "outletId", "inventoryItemId", SUM(q) AS qty,
         jsonb_object_agg(type, q) AS by_type
  FROM (SELECT "outletId", "inventoryItemId", type, SUM(quantity) AS q FROM "InventoryTransaction" GROUP BY 1, 2, 3) t
  GROUP BY 1, 2
) l ON l."outletId" = s."outletId" AND l."inventoryItemId" = s."inventoryItemId"
WHERE ABS(COALESCE(s.quantity, 0) - COALESCE(l.qty, 0)) > 0.0005;

-- @check C02 latest_balance_after_equals_stock
-- The newest ledger row's running balance equals the stored stock (only where the newest row
-- is unambiguous — two rows in the same millisecond are skipped).
WITH ranked AS (
  SELECT t.*, COUNT(*) OVER (PARTITION BY "outletId", "inventoryItemId", "createdAt") AS same_ms,
         ROW_NUMBER() OVER (PARTITION BY "outletId", "inventoryItemId" ORDER BY "createdAt" DESC) AS rn
  FROM "InventoryTransaction" t
)
SELECT r."outletId", r."inventoryItemId", r."balanceAfter", s.quantity
FROM ranked r JOIN "InventoryStock" s ON s."outletId" = r."outletId" AND s."inventoryItemId" = r."inventoryItemId"
WHERE r.rn = 1 AND r.same_ms = 1 AND ABS(r."balanceAfter" - s.quantity) > 0.0005;

-- @check C03 sale_movements_belong_to_bills
-- Recipe deductions point at a bill of the same outlet, and each bill deducts each ingredient
-- once (one SALE row per bill and item).
SELECT t."refId" AS order_id, t."inventoryItemId", t."outletId", COUNT(*) AS sale_rows, MAX(o."outletId") AS order_outlet
FROM "InventoryTransaction" t LEFT JOIN "Order" o ON o.id = t."refId"
WHERE t.type = 'SALE'
GROUP BY t."refId", t."inventoryItemId", t."outletId"
HAVING COUNT(*) > 1 OR MAX(o."outletId") IS NULL OR MAX(o."outletId") <> t."outletId"
    OR bool_or(t."refType" IS DISTINCT FROM 'Order');

-- @check C04 transfer_movements_match_status
-- DISPATCHED: TRANSFER_OUT at the source for every line, nothing in yet. RECEIVED: OUT at the
-- source and the same quantity IN at the destination. Anything else: no movements at all.
WITH lines AS (
  SELECT t.id, t.status, t."fromOutletId", t."toOutletId", i."inventoryItemId", SUM(i.quantity) AS qty
  FROM "StockTransfer" t JOIN "StockTransferItem" i ON i."transferId" = t.id
  GROUP BY t.id, i."inventoryItemId"
), mv AS (
  SELECT "refId", "inventoryItemId",
         SUM(quantity) FILTER (WHERE type = 'TRANSFER_OUT') AS out_q, MAX("outletId") FILTER (WHERE type = 'TRANSFER_OUT') AS out_outlet,
         SUM(quantity) FILTER (WHERE type = 'TRANSFER_IN') AS in_q, MAX("outletId") FILTER (WHERE type = 'TRANSFER_IN') AS in_outlet
  FROM "InventoryTransaction" WHERE "refType" = 'StockTransfer' GROUP BY 1, 2
)
SELECT l.id, l.status, l."inventoryItemId", l.qty, mv.out_q, mv.in_q
FROM lines l LEFT JOIN mv ON mv."refId" = l.id AND mv."inventoryItemId" = l."inventoryItemId"
WHERE CASE
  WHEN l.status = 'DISPATCHED' THEN ABS(COALESCE(mv.out_q, 0) + l.qty) > 0.0005 OR mv.in_q IS NOT NULL OR mv.out_outlet IS DISTINCT FROM l."fromOutletId"
  WHEN l.status = 'RECEIVED' THEN ABS(COALESCE(mv.out_q, 0) + l.qty) > 0.0005 OR ABS(COALESCE(mv.in_q, 0) - l.qty) > 0.0005
                                  OR mv.out_outlet IS DISTINCT FROM l."fromOutletId" OR mv.in_outlet IS DISTINCT FROM l."toOutletId"
  ELSE mv.out_q IS NOT NULL OR mv.in_q IS NOT NULL
END;

-- @check C05 purchase_movements_match_status
-- RECEIVED: PURCHASE movements = the purchase lines. CANCELLED after receiving: PURCHASE then
-- RETURN, net zero. DRAFT (or cancelled draft): no movements.
WITH lines AS (
  SELECT p.id, p.status, p."outletId", i."inventoryItemId", SUM(i.quantity) AS qty
  FROM "Purchase" p JOIN "PurchaseItem" i ON i."purchaseId" = p.id GROUP BY p.id, i."inventoryItemId"
), mv AS (
  SELECT "refId", "inventoryItemId", MAX("outletId") AS outlet,
         SUM(quantity) FILTER (WHERE type = 'PURCHASE') AS in_q, SUM(quantity) FILTER (WHERE type = 'RETURN') AS ret_q
  FROM "InventoryTransaction" WHERE "refType" = 'Purchase' GROUP BY 1, 2
)
SELECT l.id, l.status, l."inventoryItemId", l.qty, mv.in_q, mv.ret_q
FROM lines l LEFT JOIN mv ON mv."refId" = l.id AND mv."inventoryItemId" = l."inventoryItemId"
WHERE CASE
  WHEN l.status = 'RECEIVED' THEN ABS(COALESCE(mv.in_q, 0) - l.qty) > 0.0005 OR mv.ret_q IS NOT NULL OR mv.outlet IS DISTINCT FROM l."outletId"
  WHEN l.status = 'CANCELLED' THEN ABS(COALESCE(mv.in_q, 0) + COALESCE(mv.ret_q, 0)) > 0.0005
  ELSE mv.in_q IS NOT NULL OR mv.ret_q IS NOT NULL
END;

-- @check C06 audit_movements_only_for_completed_audits
-- AUDIT movements exist only for COMPLETED stock audits, at the audit's outlet, for items on it.
SELECT t.id, t."refId" AS audit_id, a.status, t."outletId", a."outletId" AS audit_outlet, t."inventoryItemId"
FROM "InventoryTransaction" t
LEFT JOIN "StockAudit" a ON a.id = t."refId"
LEFT JOIN "StockAuditLine" al ON al."auditId" = a.id AND al."inventoryItemId" = t."inventoryItemId"
WHERE t.type = 'AUDIT'
  AND (a.id IS NULL OR a.status <> 'COMPLETED' OR a."outletId" <> t."outletId" OR al.id IS NULL);

-- @check C07 restock_movements_match_credit_notes
-- Ingredients put back by a refund point at a credit note marked restocked, at its outlet.
SELECT t.id, t."refId", cn.restocked, cn."outletId", t."outletId"
FROM "InventoryTransaction" t LEFT JOIN "CreditNote" cn ON cn.id = t."refId"
WHERE t."refType" = 'CreditNote' AND (cn.id IS NULL OR NOT cn.restocked OR cn."outletId" <> t."outletId" OR t.type <> 'SALE_REVERSAL');


-- -------------------------------------------------------------------------------------
-- D. Delivery partner cash (COD)
--    cash in hand = Σ cash collected at the door (Payment CASH, collectedById = partner)
--                 − Σ cash handed over (DeliveryCashHandover). It is derived, not stored;
--    what is stored is Delivery.cashSettledAt (FIFO: a delivery is settled once handovers
--    cover all cash collected up to and including it).
-- -------------------------------------------------------------------------------------

-- @check D01 door_cash_belongs_to_a_delivery
-- Money recorded as collected by someone at the door belongs to a delivery order of the
-- same outlet.
SELECT p.id, p."orderId", p.mode, p.amount, p."collectedById", o."orderType", d.id AS delivery_id
FROM "Payment" p JOIN "Order" o ON o.id = p."orderId" LEFT JOIN "Delivery" d ON d."orderId" = o.id
WHERE p."collectedById" IS NOT NULL AND p.status = 'SUCCESS' AND (d.id IS NULL OR d."outletId" <> o."outletId");

-- @check D02 settled_deliveries_are_covered_by_handovers
-- A delivery flagged "cash handed over" must be covered by the partner's handovers (FIFO by
-- collection time). The reverse lag (covered but not yet flagged) is fixed by the next
-- handover and is not a books problem.
WITH cash AS (
  SELECT o."outletId", p."collectedById" AS agent, p."orderId", p.amount, p."confirmedAt",
         SUM(p.amount) OVER (PARTITION BY o."outletId", p."collectedById" ORDER BY p."confirmedAt", p.id) AS running
  FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
  WHERE p.mode = 'CASH' AND p.status = 'SUCCESS' AND p."collectedById" IS NOT NULL
), handed AS (
  SELECT "outletId", "agentId", SUM(amount) AS amt FROM "DeliveryCashHandover" GROUP BY 1, 2
)
SELECT d.id AS delivery_id, cash."orderId", cash.agent, cash.running AS collected_up_to_here, COALESCE(h.amt, 0) AS handed_over
FROM cash JOIN "Delivery" d ON d."orderId" = cash."orderId"
LEFT JOIN handed h ON h."outletId" = cash."outletId" AND h."agentId" = cash.agent
WHERE d."cashSettledAt" IS NOT NULL AND cash.running > COALESCE(h.amt, 0);

-- @warn D03 partner_cash_in_hand_negative
-- More was recorded as handed over than the partner ever collected (the API allows it with a
-- warning "partner is in credit" — usually a typo in a handover amount).
WITH col AS (
  SELECT o."outletId", p."collectedById" AS agent, SUM(p.amount) AS amt
  FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
  WHERE p.mode = 'CASH' AND p.status = 'SUCCESS' AND p."collectedById" IS NOT NULL GROUP BY 1, 2
), han AS (SELECT "outletId", "agentId" AS agent, SUM(amount) AS amt FROM "DeliveryCashHandover" GROUP BY 1, 2)
SELECT han."outletId", han.agent, COALESCE(col.amt, 0) AS collected, han.amt AS handed_over, COALESCE(col.amt, 0) - han.amt AS cash_in_hand
FROM han LEFT JOIN col ON col."outletId" = han."outletId" AND col.agent = han.agent
WHERE COALESCE(col.amt, 0) - han.amt < 0;


-- -------------------------------------------------------------------------------------
-- E. Invoice and credit-note numbering (GST: unique, consecutive, per financial year)
--    Normal bills: <prefix>-<FY>-<seq> from InvoiceCounter(outlet, FY) — consecutive from 1,
--    no gaps, no duplicates. A cancelled bill KEEPS its number (it is still counted), so
--    cancellations never create gaps. A change of the outlet's prefix mid-year continues the
--    same counter, so the series is checked per outlet and FY across prefixes.
--    Offline device series (<prefix(3)><code>-<FY>-<seq>, OFFLINE_INVOICE_SERIES) are
--    separate: no duplicates, never beyond what the device reported (gaps are a warning: a
--    device can lose an unsynced bill).
-- -------------------------------------------------------------------------------------

-- @check E01 invoice_numbers_parse_and_match_fy
-- Every invoice number has the <prefix>-<FY>-<seq> shape and its FY is the bill's financial
-- year (April–March, outlet timezone).
SELECT o.id, o."outletId", o."invoiceNumber", o."createdAt"
FROM "Order" o JOIN "Outlet" ot ON ot.id = o."outletId"
WHERE o."invoiceNumber" !~ '^.+-[0-9]{4}-[0-9]+$'
   OR substring(o."invoiceNumber" from '-([0-9]{4})-[0-9]+$')::int <>
      (CASE WHEN EXTRACT(MONTH FROM (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ot.timezone) >= 4
            THEN EXTRACT(YEAR FROM (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ot.timezone)
            ELSE EXTRACT(YEAR FROM (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ot.timezone) - 1 END)::int;

-- @check E02 main_series_consecutive_without_gaps
-- Per outlet and FY: the normal series uses every number 1..InvoiceCounter.lastSeq exactly
-- once (cancelled bills included) and nothing beyond it.
WITH inv AS (
  SELECT o.id, o."outletId", o."syncedOffline",
         substring(o."invoiceNumber" from '^(.*)-[0-9]{4}-[0-9]+$') AS prefix,
         substring(o."invoiceNumber" from '-([0-9]{4})-[0-9]+$')::int AS fy,
         substring(o."invoiceNumber" from '-([0-9]+)$')::int AS seq
  FROM "Order" o WHERE o."invoiceNumber" ~ '^.+-[0-9]{4}-[0-9]+$'
), main AS (
  SELECT inv.* FROM inv JOIN "Outlet" ot ON ot.id = inv."outletId"
  WHERE NOT (inv."syncedOffline" AND inv.prefix <> ot."invoicePrefix" AND EXISTS (
    SELECT 1 FROM "OfflineSeries" s WHERE s."outletId" = inv."outletId" AND inv.prefix = left(ot."invoicePrefix", 3) || s.code))
), used AS (
  SELECT "outletId", fy, seq, COUNT(*) AS n FROM main GROUP BY 1, 2, 3
)
SELECT 'gap' AS problem, c."outletId", c."fyStart" AS fy, g.seq, 0 AS times_used
FROM "InvoiceCounter" c CROSS JOIN LATERAL generate_series(1, c."lastSeq") AS g(seq)
LEFT JOIN used u ON u."outletId" = c."outletId" AND u.fy = c."fyStart" AND u.seq = g.seq
WHERE u.seq IS NULL
UNION ALL
SELECT 'duplicate', u."outletId", u.fy, u.seq, u.n FROM used u WHERE u.n > 1
UNION ALL
SELECT 'beyond_counter', u."outletId", u.fy, u.seq, u.n
FROM used u LEFT JOIN "InvoiceCounter" c ON c."outletId" = u."outletId" AND c."fyStart" = u.fy
WHERE c."outletId" IS NULL OR u.seq > c."lastSeq" OR u.seq < 1;

-- @check E03 offline_series_numbers_valid
-- Offline device numbers: unique per series and FY, and never beyond the device's own
-- last number for that FY (OfflineSeries.lastSeqByFy).
WITH inv AS (
  SELECT o.id, o."outletId", o."invoiceNumber", s.id AS series_id, s."lastSeqByFy",
         substring(o."invoiceNumber" from '-([0-9]{4})-[0-9]+$') AS fy,
         substring(o."invoiceNumber" from '-([0-9]+)$')::int AS seq
  FROM "Order" o JOIN "Outlet" ot ON ot.id = o."outletId"
  JOIN "OfflineSeries" s ON s."outletId" = o."outletId"
   AND substring(o."invoiceNumber" from '^(.*)-[0-9]{4}-[0-9]+$') = left(ot."invoicePrefix", 3) || s.code
  WHERE o."syncedOffline" AND substring(o."invoiceNumber" from '^(.*)-[0-9]{4}-[0-9]+$') <> ot."invoicePrefix"
)
SELECT series_id, fy, seq, COUNT(*) AS times_used, MAX(("lastSeqByFy" ->> fy)::int) AS device_last
FROM inv GROUP BY series_id, fy, seq
HAVING COUNT(*) > 1 OR seq > COALESCE(MAX(("lastSeqByFy" ->> fy)::int), 0);

-- @warn E04 offline_series_gaps
-- Numbers a device skipped (a bill raised offline that never synced, or a reinstall).
WITH inv AS (
  SELECT s.id AS series_id, substring(o."invoiceNumber" from '-([0-9]{4})-[0-9]+$') AS fy,
         substring(o."invoiceNumber" from '-([0-9]+)$')::int AS seq
  FROM "Order" o JOIN "Outlet" ot ON ot.id = o."outletId"
  JOIN "OfflineSeries" s ON s."outletId" = o."outletId"
   AND substring(o."invoiceNumber" from '^(.*)-[0-9]{4}-[0-9]+$') = left(ot."invoicePrefix", 3) || s.code
  WHERE o."syncedOffline" AND substring(o."invoiceNumber" from '^(.*)-[0-9]{4}-[0-9]+$') <> ot."invoicePrefix"
), bounds AS (SELECT series_id, fy, MAX(seq) AS hi FROM inv GROUP BY 1, 2)
SELECT b.series_id, b.fy, g.seq AS missing
FROM bounds b CROSS JOIN LATERAL generate_series(1, b.hi) AS g(seq)
LEFT JOIN inv ON inv.series_id = b.series_id AND inv.fy = b.fy AND inv.seq = g.seq
WHERE inv.seq IS NULL;

-- @check E05 credit_note_series_consecutive
-- Credit notes: CN<prefix(4)>-<FY>-<seq>, consecutive 1..CreditNoteCounter.lastSeq per
-- outlet and FY, no duplicates, the number's FY = the note's fyStart.
WITH cn AS (
  SELECT "outletId", "fyStart", number,
         substring(number from '-([0-9]{4})-[0-9]+$')::int AS fy,
         substring(number from '-([0-9]+)$')::int AS seq
  FROM "CreditNote"
), used AS (SELECT "outletId", "fyStart", seq, COUNT(*) AS n, bool_or(fy IS DISTINCT FROM "fyStart") AS fy_mismatch FROM cn GROUP BY 1, 2, 3)
SELECT 'gap' AS problem, c."outletId", c."fyStart", g.seq, 0 AS n
FROM "CreditNoteCounter" c CROSS JOIN LATERAL generate_series(1, c."lastSeq") AS g(seq)
LEFT JOIN used u ON u."outletId" = c."outletId" AND u."fyStart" = c."fyStart" AND u.seq = g.seq
WHERE u.seq IS NULL
UNION ALL
SELECT 'duplicate_or_fy', u."outletId", u."fyStart", u.seq, u.n FROM used u WHERE u.n > 1 OR u.fy_mismatch
UNION ALL
SELECT 'beyond_counter', u."outletId", u."fyStart", u.seq, u.n
FROM used u LEFT JOIN "CreditNoteCounter" c ON c."outletId" = u."outletId" AND c."fyStart" = u."fyStart"
WHERE c."outletId" IS NULL OR u.seq > c."lastSeq";

-- @warn E06 same_invoice_number_under_one_gstin
-- GST wants invoice numbers unique per GSTIN and FY. Two outlets registered under the same
-- GSTIN with the same prefix issue the same numbers (each outlet has its own counter).
SELECT a.gstin, o1."invoiceNumber", COUNT(DISTINCT o1."outletId") AS outlets
FROM "Order" o1 JOIN "Outlet" a ON a.id = o1."outletId"
WHERE a.gstin IS NOT NULL AND a.gstin <> '' AND o1."documentType" <> 'BILL'
GROUP BY a.gstin, o1."invoiceNumber"
HAVING COUNT(DISTINCT o1."outletId") > 1;


-- -------------------------------------------------------------------------------------
-- F. Cash shifts (drawer) — stored figures = recomputed from the ledgers
--    expected = opening float + counter cash payments (+ cash tips) + gift cards sold for cash
--             + wallet top-ups / meal tokens sold for cash + delivery cash handed over
--             + pay-ins − pay-outs − cash refunds − cash of paid bills voided in the shift
--    (services/cash-shifts.ts shiftSummary; window = [openedAt, closedAt)).
-- -------------------------------------------------------------------------------------

-- @check F01 closed_shift_figures_add_up
-- The frozen Z-report is internally consistent: variance = counted − expected, the summary's
-- expected cash = the stored one = the sum of the summary's own lines (works for shifts closed
-- under any earlier version of the formula).
SELECT id, "outletId", "openingFloat", "expectedCash", "countedCash", variance, summary ->> 'expectedCash' AS summary_expected
FROM "CashShift"
WHERE status = 'CLOSED' AND (
     variance IS DISTINCT FROM "countedCash" - "expectedCash"
  OR (summary ->> 'expectedCash')::int IS DISTINCT FROM "expectedCash"
  OR "expectedCash" IS DISTINCT FROM "openingFloat"
       + COALESCE((summary ->> 'counterCash')::int, 0) + COALESCE((summary ->> 'cashTips')::int, 0)
       + COALESCE((summary ->> 'giftCardCashSales')::int, 0) + COALESCE((summary ->> 'canteenCashTopups')::int, 0)
       + COALESCE((summary ->> 'deliveryCashHandedOver')::int, 0) + COALESCE((summary ->> 'payIns')::int, 0)
       - COALESCE((summary ->> 'payOuts')::int, 0) - COALESCE((summary ->> 'cashRefunds')::int, 0)
       - COALESCE((summary ->> 'voidCashReturned')::int, 0));

-- @check F02 closed_shift_expected_cash_recomputes
-- Shifts closed with today's formula (their summary has the "voidCashReturned" line, QA BUG-050):
-- the stored expected cash = the same figure recomputed now from the ledgers. A difference means
-- money moved inside the shift's window after it was closed (a back-dated handover, an edit) or
-- a payment committed while the shift was being closed.
WITH s AS (SELECT * FROM "CashShift" WHERE status = 'CLOSED'),
calc AS (
  SELECT s.id, s."outletId", s."expectedCash", s."countedCash", s.variance, (s.summary ->> 'expectedCash')::int AS summary_expected, (s.summary -> 'voidCashReturned') IS NOT NULL AS has_current_formula,
    s."openingFloat"
    + COALESCE((SELECT SUM(p.amount + p.tip) FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."outletId" = s."outletId" AND p.status = 'SUCCESS' AND p.mode = 'CASH' AND p."collectedById" IS NULL
                  AND p."createdAt" >= s."openedAt" AND p."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(g."initialValue") FROM "GiftCard" g
                WHERE g."soldOutletId" = s."outletId" AND g."soldMode" = 'CASH' AND g."createdAt" >= s."openedAt" AND g."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(w.amount) FROM "WalletTxn" w
                WHERE w."outletId" = s."outletId" AND w.type = 'TOPUP' AND w.mode = 'CASH' AND w."createdAt" >= s."openedAt" AND w."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(t.amount) FROM "MealTokenTxn" t
                WHERE t."outletId" = s."outletId" AND t.type = 'PURCHASE' AND t.mode = 'CASH' AND t."createdAt" >= s."openedAt" AND t."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(h.amount) FROM "DeliveryCashHandover" h
                WHERE h."outletId" = s."outletId" AND h."receivedAt" >= s."openedAt" AND h."receivedAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(CASE WHEN m.type = 'PAY_IN' THEN m.amount ELSE -m.amount END) FROM "CashMovement" m WHERE m."shiftId" = s.id), 0)
    - COALESCE((SELECT SUM(cn.amount) FROM "CreditNote" cn
                WHERE cn."outletId" = s."outletId" AND cn."refundMode" = 'CASH' AND cn."createdAt" >= s."openedAt" AND cn."createdAt" < s."closedAt"), 0)
    - COALESCE((SELECT SUM(p.amount) FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."outletId" = s."outletId" AND o.status = 'CANCELLED' AND o."cancelledAt" >= s."openedAt" AND o."cancelledAt" < s."closedAt"
                  AND p.status = 'SUCCESS' AND p.mode = 'CASH' AND p."collectedById" IS NULL), 0) AS recomputed
  FROM s
)
SELECT * FROM calc WHERE has_current_formula AND "expectedCash" IS DISTINCT FROM recomputed;

-- @warn F03 old_formula_shift_differs_from_today
-- Shifts closed before the expected-cash formula last changed (no "voidCashReturned" line): their
-- frozen figure is what the cashier was shown and stays as is; today's formula gives another number.
WITH s AS (SELECT * FROM "CashShift" WHERE status = 'CLOSED'),
calc AS (
  SELECT s.id, s."outletId", s."expectedCash", s."countedCash", s.variance, (s.summary ->> 'expectedCash')::int AS summary_expected, (s.summary -> 'voidCashReturned') IS NOT NULL AS has_current_formula,
    s."openingFloat"
    + COALESCE((SELECT SUM(p.amount + p.tip) FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."outletId" = s."outletId" AND p.status = 'SUCCESS' AND p.mode = 'CASH' AND p."collectedById" IS NULL
                  AND p."createdAt" >= s."openedAt" AND p."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(g."initialValue") FROM "GiftCard" g
                WHERE g."soldOutletId" = s."outletId" AND g."soldMode" = 'CASH' AND g."createdAt" >= s."openedAt" AND g."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(w.amount) FROM "WalletTxn" w
                WHERE w."outletId" = s."outletId" AND w.type = 'TOPUP' AND w.mode = 'CASH' AND w."createdAt" >= s."openedAt" AND w."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(t.amount) FROM "MealTokenTxn" t
                WHERE t."outletId" = s."outletId" AND t.type = 'PURCHASE' AND t.mode = 'CASH' AND t."createdAt" >= s."openedAt" AND t."createdAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(h.amount) FROM "DeliveryCashHandover" h
                WHERE h."outletId" = s."outletId" AND h."receivedAt" >= s."openedAt" AND h."receivedAt" < s."closedAt"), 0)
    + COALESCE((SELECT SUM(CASE WHEN m.type = 'PAY_IN' THEN m.amount ELSE -m.amount END) FROM "CashMovement" m WHERE m."shiftId" = s.id), 0)
    - COALESCE((SELECT SUM(cn.amount) FROM "CreditNote" cn
                WHERE cn."outletId" = s."outletId" AND cn."refundMode" = 'CASH' AND cn."createdAt" >= s."openedAt" AND cn."createdAt" < s."closedAt"), 0)
    - COALESCE((SELECT SUM(p.amount) FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."outletId" = s."outletId" AND o.status = 'CANCELLED' AND o."cancelledAt" >= s."openedAt" AND o."cancelledAt" < s."closedAt"
                  AND p.status = 'SUCCESS' AND p.mode = 'CASH' AND p."collectedById" IS NULL), 0) AS recomputed
  FROM s
)
SELECT * FROM calc WHERE NOT has_current_formula AND "expectedCash" IS DISTINCT FROM recomputed;

-- @check F04 one_open_shift_per_outlet
SELECT "outletId", COUNT(*) AS open_shifts FROM "CashShift" WHERE status = 'OPEN' GROUP BY 1 HAVING COUNT(*) > 1;


-- -------------------------------------------------------------------------------------
-- G. Kitchen tickets (KOT) and orders
-- -------------------------------------------------------------------------------------

-- @check G01 kot_belongs_to_its_bill_or_tab
-- A KOT hangs off a bill or a running tab of the same outlet.
SELECT k.id, k."outletId", k."orderId", o."outletId" AS order_outlet, k."sessionId", ts."outletId" AS session_outlet
FROM "KotTicket" k
LEFT JOIN "Order" o ON o.id = k."orderId"
LEFT JOIN "TableSession" ts ON ts.id = k."sessionId"
WHERE (k."orderId" IS NULL AND k."sessionId" IS NULL)
   OR (o.id IS NOT NULL AND o."outletId" <> k."outletId")
   OR (ts.id IS NOT NULL AND ts."outletId" <> k."outletId");

-- @check G02 kot_numbers_unique_per_outlet_day
-- KOT numbers restart daily per outlet (outlet timezone) and never repeat within a day.
SELECT k."outletId", ((k."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ot.timezone)::date AS day, k."kotNumber", COUNT(*) AS tickets
FROM "KotTicket" k JOIN "Outlet" ot ON ot.id = k."outletId"
GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;

-- @check G03 billed_tab_items_point_at_live_bills
-- A running-tab item marked billed points at a bill of the same tab (or a tab merged into it).
SELECT i.id, i."sessionId", i."billedOrderId", o."tableSessionId"
FROM "TableSessionItem" i LEFT JOIN "Order" o ON o.id = i."billedOrderId"
WHERE i."billedOrderId" IS NOT NULL AND (o.id IS NULL OR o."tableSessionId" IS DISTINCT FROM i."sessionId");

-- @check G04 open_tab_per_table
-- At most one OPEN tab per table (a table merged into a tab counts as that tab's).
WITH t AS (
  SELECT id, "tableId" AS table_id FROM "TableSession" WHERE status = 'OPEN'
  UNION ALL
  SELECT id, unnest("mergedTableIds") FROM "TableSession" WHERE status = 'OPEN'
)
SELECT table_id, COUNT(DISTINCT id) AS open_tabs FROM t GROUP BY 1 HAVING COUNT(DISTINCT id) > 1;

-- @check G05 closed_tabs_have_nothing_unbilled
-- A closed tab has no unbilled items left behind (they would be lost to billing).
SELECT s.id, s.status, COUNT(i.id) AS unbilled_items
FROM "TableSession" s JOIN "TableSessionItem" i ON i."sessionId" = s.id AND i."billedOrderId" IS NULL
WHERE s.status = 'CLOSED'
GROUP BY s.id;
