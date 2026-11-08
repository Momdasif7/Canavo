-- AlterEnum
ALTER TYPE "BusinessStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "deleteAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerAddress" TEXT,
ADD COLUMN     "buyerGstin" TEXT,
ADD COLUMN     "buyerName" TEXT,
ADD COLUMN     "placeOfSupply" TEXT;

