-- AlterTable
ALTER TABLE "OutletItemOverride" ADD COLUMN     "stockOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stockOutReason" TEXT,
ADD COLUMN     "stockOutVariantIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

