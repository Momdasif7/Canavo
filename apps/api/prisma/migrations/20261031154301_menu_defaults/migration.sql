-- AlterTable
ALTER TABLE "MenuItem" ALTER COLUMN "gstRate" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "posShowImages" BOOLEAN NOT NULL DEFAULT true;


-- New menu items default to GST 0%.
-- 1. Items that followed the business default rate are pinned to it, so their GST doesn't change.
UPDATE "MenuItem" m SET "taxRateId" = t."id"
FROM "TaxRate" t
WHERE t."businessId" = m."businessId" AND t."isDefault" = true AND t."active" = true AND m."taxRateId" IS NULL;

-- 2. Every business gets a 0% rate (if missing) and it becomes the default.
INSERT INTO "TaxRate" ("id", "businessId", "name", "cgst", "sgst", "igst", "cess", "extras", "isDefault", "active", "createdAt", "updatedAt")
SELECT 'tax0_' || b."id", b."id", 'GST 0% (Exempt)', 0, 0, 0, 0, '[]', false, true, now(), now()
FROM "Business" b
WHERE NOT EXISTS (
  SELECT 1 FROM "TaxRate" t WHERE t."businessId" = b."id" AND t."cgst" = 0 AND t."sgst" = 0 AND t."igst" = 0 AND t."cess" = 0 AND t."active" = true
);
UPDATE "TaxRate" SET "isDefault" = false WHERE "isDefault" = true;
UPDATE "TaxRate" t SET "isDefault" = true
WHERE t."id" IN (
  SELECT DISTINCT ON ("businessId") "id" FROM "TaxRate"
  WHERE "cgst" = 0 AND "sgst" = 0 AND "igst" = 0 AND "cess" = 0 AND "active" = true
  ORDER BY "businessId", "createdAt" ASC
);
