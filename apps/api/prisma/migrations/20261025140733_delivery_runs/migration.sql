-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "maxDeliveriesPerPartner" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deliveryAtOutlet" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deliveryRunStartedAt" TIMESTAMP(3),
ADD COLUMN     "lastLat" DOUBLE PRECISION,
ADD COLUMN     "lastLng" DOUBLE PRECISION,
ADD COLUMN     "lastLocationAt" TIMESTAMP(3);

