-- QA Phase 7: rows that would violate the constraints of migrations 20261106120000_check_constraints and
-- 20261106120200_table_session_one_open. Read-only; every count must be 0 before migrate deploy.
--   BEGIN READ ONLY; SET LOCAL app.bypass_rls = 'on'; \i docs/qa/sql/constraint-precheck.sql  ROLLBACK;
SELECT "constraint", violations FROM (
  SELECT 'Order_money_nonneg_check'::text AS "constraint", count(*) AS violations FROM "Order" WHERE NOT ("subtotal" >= 0 AND "discount" >= 0 AND "taxableValue" >= 0 AND "serviceCharge" >= 0 AND "cgst" >= 0 AND "sgst" >= 0 AND "igst" >= 0 AND "cess" >= 0 AND "otherTaxes" >= 0 AND "grandTotal" >= 0 AND "promoDiscount" >= 0 AND "pointsRedeemed" >= 0 AND "extraCharges" >= 0)
UNION ALL
  SELECT 'Order_refunded_range_check'::text AS "constraint", count(*) AS violations FROM "Order" WHERE NOT ("refundedAmount" >= 0 AND "refundedAmount" <= "grandTotal")
UNION ALL
  SELECT 'OrderItem_quantity_check'::text AS "constraint", count(*) AS violations FROM "OrderItem" WHERE NOT ("quantity" > 0)
UNION ALL
  SELECT 'OrderItem_money_nonneg_check'::text AS "constraint", count(*) AS violations FROM "OrderItem" WHERE NOT ("unitPrice" >= 0 AND "discount" >= 0 AND "taxableValue" >= 0 AND "serviceCharge" >= 0 AND "cgst" >= 0 AND "sgst" >= 0 AND "igst" >= 0 AND "cess" >= 0 AND "otherTaxes" >= 0 AND "total" >= 0 AND "gstRate" >= 0)
UNION ALL
  SELECT 'Payment_amount_nonneg_check'::text AS "constraint", count(*) AS violations FROM "Payment" WHERE NOT ("amount" >= 0 AND "tip" >= 0 AND ("tokens" IS NULL OR "tokens" > 0))
UNION ALL
  SELECT 'CreditNote_amount_nonneg_check'::text AS "constraint", count(*) AS violations FROM "CreditNote" WHERE NOT ("amount" >= 0)
UNION ALL
  SELECT 'CouponRedemption_amount_nonneg_check'::text AS "constraint", count(*) AS violations FROM "CouponRedemption" WHERE NOT ("amount" >= 0)
UNION ALL
  SELECT 'KhataTransaction_amount_nonneg_check'::text AS "constraint", count(*) AS violations FROM "KhataTransaction" WHERE NOT ("amount" >= 0)
UNION ALL
  SELECT 'InvoiceCounter_lastSeq_check'::text AS "constraint", count(*) AS violations FROM "InvoiceCounter" WHERE NOT ("lastSeq" >= 0)
UNION ALL
  SELECT 'CreditNoteCounter_lastSeq_check'::text AS "constraint", count(*) AS violations FROM "CreditNoteCounter" WHERE NOT ("lastSeq" >= 0)
UNION ALL
  SELECT 'MenuItem_price_check'::text AS "constraint", count(*) AS violations FROM "MenuItem" WHERE NOT ("price" >= 0 AND "gstRate" >= 0)
UNION ALL
  SELECT 'ItemVariant_price_check'::text AS "constraint", count(*) AS violations FROM "ItemVariant" WHERE NOT ("price" >= 0)
UNION ALL
  SELECT 'ItemAddon_price_check'::text AS "constraint", count(*) AS violations FROM "ItemAddon" WHERE NOT ("price" >= 0)
UNION ALL
  SELECT 'OutletItemOverride_price_check'::text AS "constraint", count(*) AS violations FROM "OutletItemOverride" WHERE NOT ("price" IS NULL OR "price" >= 0)
UNION ALL
  SELECT 'MealSlotItem_price_check'::text AS "constraint", count(*) AS violations FROM "MealSlotItem" WHERE NOT ("price" IS NULL OR "price" >= 0)
UNION ALL
  SELECT 'TaxRate_percent_check'::text AS "constraint", count(*) AS violations FROM "TaxRate" WHERE NOT ("cgst" >= 0 AND "sgst" >= 0 AND "igst" >= 0 AND "cess" >= 0)
UNION ALL
  SELECT 'Outlet_charges_check'::text AS "constraint", count(*) AS violations FROM "Outlet" WHERE NOT ("serviceChargePercent" >= 0 AND "serviceChargePercent" <= 100 AND "packagingCharge" >= 0 AND "approvalDiscountPercent" >= 0 AND "approvalDiscountPercent" <= 100 AND "maxDeliveriesPerPartner" >= 1)
UNION ALL
  SELECT 'Customer_balances_check'::text AS "constraint", count(*) AS violations FROM "Customer" WHERE NOT ("walletBalance" >= 0 AND "points" >= 0 AND "khataLimit" >= 0 AND "totalSpend" >= 0 AND "visitCount" >= 0)
UNION ALL
  SELECT 'GiftCard_balance_check'::text AS "constraint", count(*) AS violations FROM "GiftCard" WHERE NOT ("balance" >= 0 AND "initialValue" >= 0)
UNION ALL
  SELECT 'MealTokenAccount_balance_check'::text AS "constraint", count(*) AS violations FROM "MealTokenAccount" WHERE NOT ("balance" >= 0 AND "value" >= 0)
UNION ALL
  SELECT 'Coupon_values_check'::text AS "constraint", count(*) AS violations FROM "Coupon" WHERE NOT ("value" >= 0 AND "usedCount" >= 0 AND "minOrder" >= 0 AND ("maxDiscount" IS NULL OR "maxDiscount" >= 0))
UNION ALL
  SELECT 'CashShift_cash_check'::text AS "constraint", count(*) AS violations FROM "CashShift" WHERE NOT ("openingFloat" >= 0 AND ("countedCash" IS NULL OR "countedCash" >= 0))
UNION ALL
  SELECT 'CashMovement_amount_check'::text AS "constraint", count(*) AS violations FROM "CashMovement" WHERE NOT ("amount" > 0)
UNION ALL
  SELECT 'DeliveryCashHandover_amount_check'::text AS "constraint", count(*) AS violations FROM "DeliveryCashHandover" WHERE NOT ("amount" > 0)
UNION ALL
  SELECT 'Purchase_money_check'::text AS "constraint", count(*) AS violations FROM "Purchase" WHERE NOT ("subtotal" >= 0 AND "tax" >= 0 AND "total" >= 0 AND "paidAmount" >= 0)
UNION ALL
  SELECT 'PurchasePayment_amount_check'::text AS "constraint", count(*) AS violations FROM "PurchasePayment" WHERE NOT ("amount" > 0)
UNION ALL
  SELECT 'PurchaseItem_values_check'::text AS "constraint", count(*) AS violations FROM "PurchaseItem" WHERE NOT ("quantity" >= 0 AND "unitCost" >= 0 AND "taxRate" >= 0 AND "total" >= 0)
UNION ALL
  SELECT 'InventoryItem_values_check'::text AS "constraint", count(*) AS violations FROM "InventoryItem" WHERE NOT ("costPerUnit" >= 0 AND "reorderLevel" >= 0 AND "reorderQty" >= 0)
UNION ALL
  SELECT 'StockAuditLine_counted_check'::text AS "constraint", count(*) AS violations FROM "StockAuditLine" WHERE NOT ("countedQty" IS NULL OR "countedQty" >= 0)
UNION ALL
  SELECT 'CorporateAccount_creditLimit_check'::text AS "constraint", count(*) AS violations FROM "CorporateAccount" WHERE NOT ("creditLimit" >= 0)
UNION ALL
  SELECT 'CorporateStatement_meals_check'::text AS "constraint", count(*) AS violations FROM "CorporateStatement" WHERE NOT ("meals" >= 0)
UNION ALL
  SELECT 'MealSubscription_meals_check'::text AS "constraint", count(*) AS violations FROM "MealSubscription" WHERE NOT ("pricePerMeal" >= 0 AND "mealCount" > 0 AND "refundedMeals" >= 0 AND "refundedMeals" <= "mealCount")
UNION ALL
  SELECT 'DiningTable_capacity_check'::text AS "constraint", count(*) AS violations FROM "DiningTable" WHERE NOT ("capacity" > 0)
UNION ALL
  SELECT 'TableSession_guests_check'::text AS "constraint", count(*) AS violations FROM "TableSession" WHERE NOT ("guests" >= 1)
UNION ALL
  SELECT 'TableSessionItem_quantity_check'::text AS "constraint", count(*) AS violations FROM "TableSessionItem" WHERE NOT ("quantity" > 0)
UNION ALL
  SELECT 'Reservation_values_check'::text AS "constraint", count(*) AS violations FROM "Reservation" WHERE NOT ("partySize" > 0 AND "durationMin" > 0 AND "advancePaid" >= 0)
UNION ALL
  SELECT 'DeliveryZone_values_check'::text AS "constraint", count(*) AS violations FROM "DeliveryZone" WHERE NOT ("fee" >= 0 AND "minOrder" >= 0 AND "radiusKm" > 0)
UNION ALL
  SELECT 'ChannelOrder_totals_check'::text AS "constraint", count(*) AS violations FROM "ChannelOrder" WHERE NOT ("channelTotal" >= 0 AND "ourTotal" >= 0)
UNION ALL
  SELECT 'ChannelRequest_money_check'::text AS "constraint", count(*) AS violations FROM "ChannelRequest" WHERE NOT ("total" >= 0 AND ("refundAmount" IS NULL OR "refundAmount" >= 0))
UNION ALL
  SELECT 'User_salary_check'::text AS "constraint", count(*) AS violations FROM "User" WHERE NOT ("salaryAmount" >= 0)
UNION ALL
  SELECT 'TableSession_one_open_per_table', count(*) FROM (SELECT "tableId" FROM "TableSession" WHERE status = 'OPEN' GROUP BY 1 HAVING count(*) > 1) d
UNION ALL
  SELECT 'Customer_khata_balance_nonneg_check'::text, count(*) FROM "Customer" WHERE NOT ("khataBalance" >= 0)
UNION ALL
  SELECT 'GiftCard_balance_le_initial_check'::text, count(*) FROM "GiftCard" WHERE NOT ("balance" <= "initialValue")
UNION ALL
  SELECT 'TaxRate_total_le_100_check'::text, count(*) FROM "TaxRate" WHERE NOT ("cgst" + "sgst" + "cess" <= 100 AND "igst" + "cess" <= 100)
) c ORDER BY violations DESC, "constraint";
