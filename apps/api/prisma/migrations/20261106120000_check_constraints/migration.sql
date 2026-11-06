-- QA Phase 7 (database): CHECK constraints the domain demands. Prisma does not model CHECKs, so this
-- migration is SQL-only (prisma migrate diff stays empty). Each constraint is added NOT VALID: a brief
-- lock, no table scan, new and updated rows are checked from now on. The next migration VALIDATEs them
-- (SHARE UPDATE EXCLUSIVE lock only — reads and writes keep running).
--
-- Only bounds every code path already respects are enforced (see docs/qa/phase-7/dba.md). Deliberately
-- NOT constrained: Customer.khataBalance, InventoryStock.quantity / InventoryTransaction.balanceAfter
-- (negative stock is allowed by design), CreditNote tax columns, CorporateStatement.amount, signed
-- ledgers (Wallet/GiftCard/Loyalty/MealToken txns), Order.roundOff, CashShift.expectedCash/variance.
--
-- A violation raises SQLSTATE 23514; the API answers 409 (lib/http.ts).

-- Bills: all money parts are non-negative paise; refunds never exceed the bill.
ALTER TABLE "Order" ADD CONSTRAINT "Order_money_nonneg_check" CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "taxableValue" >= 0 AND "serviceCharge" >= 0 AND "cgst" >= 0 AND "sgst" >= 0
  AND "igst" >= 0 AND "cess" >= 0 AND "otherTaxes" >= 0 AND "grandTotal" >= 0 AND "promoDiscount" >= 0
  AND "pointsRedeemed" >= 0 AND "extraCharges" >= 0) NOT VALID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_refunded_range_check" CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "grandTotal") NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_check" CHECK ("quantity" > 0) NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_money_nonneg_check" CHECK (
  "unitPrice" >= 0 AND "discount" >= 0 AND "taxableValue" >= 0 AND "serviceCharge" >= 0 AND "cgst" >= 0 AND "sgst" >= 0
  AND "igst" >= 0 AND "cess" >= 0 AND "otherTaxes" >= 0 AND "total" >= 0 AND "gstRate" >= 0) NOT VALID;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_nonneg_check" CHECK ("amount" >= 0 AND "tip" >= 0 AND ("tokens" IS NULL OR "tokens" > 0)) NOT VALID;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_amount_nonneg_check" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_amount_nonneg_check" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "KhataTransaction" ADD CONSTRAINT "KhataTransaction_amount_nonneg_check" CHECK ("amount" >= 0) NOT VALID;
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_lastSeq_check" CHECK ("lastSeq" >= 0) NOT VALID;
ALTER TABLE "CreditNoteCounter" ADD CONSTRAINT "CreditNoteCounter_lastSeq_check" CHECK ("lastSeq" >= 0) NOT VALID;

-- Menu prices and tax rates.
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_price_check" CHECK ("price" >= 0 AND "gstRate" >= 0) NOT VALID;
ALTER TABLE "ItemVariant" ADD CONSTRAINT "ItemVariant_price_check" CHECK ("price" >= 0) NOT VALID;
ALTER TABLE "ItemAddon" ADD CONSTRAINT "ItemAddon_price_check" CHECK ("price" >= 0) NOT VALID;
ALTER TABLE "OutletItemOverride" ADD CONSTRAINT "OutletItemOverride_price_check" CHECK ("price" IS NULL OR "price" >= 0) NOT VALID;
ALTER TABLE "MealSlotItem" ADD CONSTRAINT "MealSlotItem_price_check" CHECK ("price" IS NULL OR "price" >= 0) NOT VALID;
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_percent_check" CHECK ("cgst" >= 0 AND "sgst" >= 0 AND "igst" >= 0 AND "cess" >= 0) NOT VALID;
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_charges_check" CHECK (
  "serviceChargePercent" >= 0 AND "serviceChargePercent" <= 100 AND "packagingCharge" >= 0
  AND "approvalDiscountPercent" >= 0 AND "approvalDiscountPercent" <= 100 AND "maxDeliveriesPerPartner" >= 1) NOT VALID;

-- Stored-value balances (liabilities): never below zero.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_balances_check" CHECK (
  "walletBalance" >= 0 AND "points" >= 0 AND "khataLimit" >= 0 AND "totalSpend" >= 0 AND "visitCount" >= 0) NOT VALID;
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_balance_check" CHECK ("balance" >= 0 AND "initialValue" >= 0) NOT VALID;
ALTER TABLE "MealTokenAccount" ADD CONSTRAINT "MealTokenAccount_balance_check" CHECK ("balance" >= 0 AND "value" >= 0) NOT VALID;
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_values_check" CHECK (
  "value" >= 0 AND "usedCount" >= 0 AND "minOrder" >= 0 AND ("maxDiscount" IS NULL OR "maxDiscount" >= 0)) NOT VALID;

-- Cash.
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_cash_check" CHECK ("openingFloat" >= 0 AND ("countedCash" IS NULL OR "countedCash" >= 0)) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_check" CHECK ("amount" > 0) NOT VALID;
ALTER TABLE "DeliveryCashHandover" ADD CONSTRAINT "DeliveryCashHandover_amount_check" CHECK ("amount" > 0) NOT VALID;

-- Purchases and inventory master data.
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_money_check" CHECK ("subtotal" >= 0 AND "tax" >= 0 AND "total" >= 0 AND "paidAmount" >= 0) NOT VALID;
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_amount_check" CHECK ("amount" > 0) NOT VALID;
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_values_check" CHECK ("quantity" >= 0 AND "unitCost" >= 0 AND "taxRate" >= 0 AND "total" >= 0) NOT VALID;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_values_check" CHECK ("costPerUnit" >= 0 AND "reorderLevel" >= 0 AND "reorderQty" >= 0) NOT VALID;
ALTER TABLE "StockAuditLine" ADD CONSTRAINT "StockAuditLine_counted_check" CHECK ("countedQty" IS NULL OR "countedQty" >= 0) NOT VALID;

-- Canteen.
ALTER TABLE "CorporateAccount" ADD CONSTRAINT "CorporateAccount_creditLimit_check" CHECK ("creditLimit" >= 0) NOT VALID;
ALTER TABLE "CorporateStatement" ADD CONSTRAINT "CorporateStatement_meals_check" CHECK ("meals" >= 0) NOT VALID;
ALTER TABLE "MealSubscription" ADD CONSTRAINT "MealSubscription_meals_check" CHECK (
  "pricePerMeal" >= 0 AND "mealCount" > 0 AND "refundedMeals" >= 0 AND "refundedMeals" <= "mealCount") NOT VALID;

-- Tables, reservations, delivery, channels, staff.
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_capacity_check" CHECK ("capacity" > 0) NOT VALID;
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_guests_check" CHECK ("guests" >= 1) NOT VALID;
ALTER TABLE "TableSessionItem" ADD CONSTRAINT "TableSessionItem_quantity_check" CHECK ("quantity" > 0) NOT VALID;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_values_check" CHECK ("partySize" > 0 AND "durationMin" > 0 AND "advancePaid" >= 0) NOT VALID;
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_values_check" CHECK ("fee" >= 0 AND "minOrder" >= 0 AND "radiusKm" > 0) NOT VALID;
ALTER TABLE "ChannelOrder" ADD CONSTRAINT "ChannelOrder_totals_check" CHECK ("channelTotal" >= 0 AND "ourTotal" >= 0) NOT VALID;
ALTER TABLE "ChannelRequest" ADD CONSTRAINT "ChannelRequest_money_check" CHECK ("total" >= 0 AND ("refundAmount" IS NULL OR "refundAmount" >= 0)) NOT VALID;
ALTER TABLE "User" ADD CONSTRAINT "User_salary_check" CHECK ("salaryAmount" >= 0) NOT VALID;
