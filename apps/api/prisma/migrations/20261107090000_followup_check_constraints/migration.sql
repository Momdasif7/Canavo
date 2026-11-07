-- QA Phase 7 follow-up: bounds every code path respects since the dbe fixes (gift-card refunds per card,
-- khata voids / credit notes / settles never below zero, tax-rate caps). Added NOT VALID (brief lock,
-- no scan); validated in the next migration. A violation raises 23514 → the API answers 409.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_khata_balance_nonneg_check" CHECK ("khataBalance" >= 0) NOT VALID;
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_balance_le_initial_check" CHECK ("balance" <= "initialValue") NOT VALID;
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_total_le_100_check" CHECK ("cgst" + "sgst" + "cess" <= 100 AND "igst" + "cess" <= 100) NOT VALID;
