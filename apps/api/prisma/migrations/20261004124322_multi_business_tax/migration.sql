-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "ownerName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
    "modules" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- Backfill: existing data becomes the "Demo Hotel" business with every module enabled
INSERT INTO "Business" ("id", "name", "status", "modules", "createdAt", "updatedAt")
VALUES ('biz_demo', 'Demo Hotel', 'ACTIVE',
        ARRAY['BILLING','KOT','TABLES','DELIVERY','RESERVATIONS','INVENTORY','CUSTOMERS','OFFERS','ATTENDANCE','REPORTS'],
        NOW(), NOW());


-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'BILL';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'BUSINESS_OWNER';

-- DropIndex
DROP INDEX "Coupon_code_key";

-- DropIndex
DROP INDEX "Customer_phone_key";

-- DropIndex
DROP INDEX "InventoryItem_barcode_key";

-- DropIndex
DROP INDEX "InventoryItem_sku_key";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';

-- AlterTable
ALTER TABLE "MenuCategory" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo',
ADD COLUMN     "taxRateId" TEXT,
ALTER COLUMN "gstRate" SET DEFAULT 5,
ALTER COLUMN "gstRate" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cess" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otherTaxes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxDetails" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "cess" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otherTaxes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxRates" JSONB NOT NULL DEFAULT '{}',
ALTER COLUMN "gstRate" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo',
ADD COLUMN     "gstEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "legalName" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "businessId" TEXT NOT NULL DEFAULT 'biz_demo';


-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cgst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "igst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cess" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extras" JSONB NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxRate_businessId_idx" ON "TaxRate"("businessId");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Coupon_businessId_idx" ON "Coupon"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_businessId_code_key" ON "Coupon"("businessId", "code");

-- CreateIndex
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_phone_key" ON "Customer"("businessId", "phone");

-- CreateIndex
CREATE INDEX "InventoryItem_businessId_idx" ON "InventoryItem"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_businessId_sku_key" ON "InventoryItem"("businessId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_businessId_barcode_key" ON "InventoryItem"("businessId", "barcode");

-- CreateIndex
CREATE INDEX "MenuCategory_businessId_idx" ON "MenuCategory"("businessId");

-- CreateIndex
CREATE INDEX "MenuItem_businessId_idx" ON "MenuItem"("businessId");

-- CreateIndex
CREATE INDEX "Offer_businessId_idx" ON "Offer"("businessId");

-- CreateIndex
CREATE INDEX "Outlet_businessId_idx" ON "Outlet"("businessId");

-- CreateIndex
CREATE INDEX "User_businessId_idx" ON "User"("businessId");

-- CreateIndex
CREATE INDEX "Vendor_businessId_idx" ON "Vendor"("businessId");

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill complete: remove temporary defaults
ALTER TABLE "Coupon" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "Customer" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "InventoryItem" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "MenuCategory" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "MenuItem" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "Offer" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "Outlet" ALTER COLUMN "businessId" DROP DEFAULT;
ALTER TABLE "Vendor" ALTER COLUMN "businessId" DROP DEFAULT;

UPDATE "User" SET "businessId" = 'biz_demo' WHERE "role" <> 'SUPER_ADMIN';
UPDATE "AuditLog" SET "businessId" = 'biz_demo';

-- Standard GST slabs for the demo business, and link menu items by their current rate
INSERT INTO "TaxRate" ("id", "businessId", "name", "cgst", "sgst", "igst", "cess", "extras", "isDefault", "active", "createdAt", "updatedAt") VALUES
  ('tax_demo_0',  'biz_demo', 'GST 0% (Exempt)', 0, 0, 0, 0, '[]', false, true, NOW(), NOW()),
  ('tax_demo_5',  'biz_demo', 'GST 5%',  2.5, 2.5, 5,  0, '[]', true,  true, NOW(), NOW()),
  ('tax_demo_12', 'biz_demo', 'GST 12%', 6,   6,   12, 0, '[]', false, true, NOW(), NOW()),
  ('tax_demo_18', 'biz_demo', 'GST 18%', 9,   9,   18, 0, '[]', false, true, NOW(), NOW()),
  ('tax_demo_28', 'biz_demo', 'GST 28%', 14,  14,  28, 0, '[]', false, true, NOW(), NOW());
UPDATE "MenuItem" SET "taxRateId" = 'tax_demo_' || CAST(CAST("gstRate" AS INTEGER) AS TEXT)
  WHERE "gstRate" IN (0, 5, 12, 18, 28);
