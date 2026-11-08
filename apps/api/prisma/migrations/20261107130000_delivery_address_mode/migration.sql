-- Product request (rqb): outlets choose how delivery addresses are taken — MAP (map pin, zones and distance
-- fees; the default, unchanged) or ADDRESS (typed address + PIN code, flat fee, optional minimum order and
-- allowed PIN codes / area names). Deliveries keep the typed PIN code.
-- CreateEnum
CREATE TYPE "DeliveryAddressMode" AS ENUM ('MAP', 'ADDRESS');

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "pincode" TEXT;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "deliveryAddressMode" "DeliveryAddressMode" NOT NULL DEFAULT 'MAP',
ADD COLUMN     "deliveryAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deliveryEtaMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "deliveryFlatFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryMinOrder" INTEGER NOT NULL DEFAULT 0;


-- Bounds the API validates (deliverySettingsSchema); new columns on a small table, so validated at once.
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_delivery_flat_fee_check" CHECK ("deliveryFlatFee" >= 0 AND "deliveryFlatFee" <= 1000000);
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_delivery_min_order_check" CHECK ("deliveryMinOrder" >= 0 AND "deliveryMinOrder" <= 10000000);
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_delivery_eta_check" CHECK ("deliveryEtaMinutes" BETWEEN 5 AND 300);
