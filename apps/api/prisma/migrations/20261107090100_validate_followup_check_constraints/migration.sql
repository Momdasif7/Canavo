-- Validate the follow-up CHECKs (SHARE UPDATE EXCLUSIVE: reads and writes keep running).
ALTER TABLE "Customer" VALIDATE CONSTRAINT "Customer_khata_balance_nonneg_check";
ALTER TABLE "GiftCard" VALIDATE CONSTRAINT "GiftCard_balance_le_initial_check";
ALTER TABLE "TaxRate" VALIDATE CONSTRAINT "TaxRate_total_le_100_check";
