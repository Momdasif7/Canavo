-- Cinema seat ordering (THEATRE module): screens are dining areas of kind SCREEN, seats are tables in them,
-- showtimes per screen, seat-order timing / pickup token on QR requests, a KOT header line for the kitchen.

-- CreateEnum
CREATE TYPE "AreaKind" AS ENUM ('FLOOR', 'SCREEN');

-- AlterTable
ALTER TABLE "ChannelRequest" ADD COLUMN     "pickupToken" INTEGER,
ADD COLUMN     "seatTiming" TEXT,
ADD COLUMN     "showTimeId" TEXT;

-- AlterTable
ALTER TABLE "DiningArea" ADD COLUMN     "code" TEXT,
ADD COLUMN     "kind" "AreaKind" NOT NULL DEFAULT 'FLOOR',
ADD COLUMN     "qrToken" TEXT;

-- AlterTable
ALTER TABLE "DiningTable" ADD COLUMN     "seatNumber" INTEGER,
ADD COLUMN     "seatRow" TEXT;

-- AlterTable
ALTER TABLE "KotTicket" ADD COLUMN     "header" TEXT;

-- CreateTable
CREATE TABLE "ShowTime" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "intervalAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3) NOT NULL,
    "orderCutoffMin" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowTime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShowTime_outletId_areaId_startsAt_idx" ON "ShowTime"("outletId", "areaId", "startsAt");

-- CreateIndex
CREATE INDEX "ChannelRequest_outletId_pickupToken_createdAt_idx" ON "ChannelRequest"("outletId", "pickupToken", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelRequest_showTimeId_idx" ON "ChannelRequest"("showTimeId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningArea_qrToken_key" ON "DiningArea"("qrToken");

-- AddForeignKey
ALTER TABLE "ShowTime" ADD CONSTRAINT "ShowTime_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowTime" ADD CONSTRAINT "ShowTime_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "DiningArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "ShowTime" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShowTime" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ShowTime";
CREATE POLICY tenant_isolation ON "ShowTime" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));

-- Domain bounds (new columns, empty or NULL on existing rows: validated at once). A violation raises 23514 → 409.
ALTER TABLE "ShowTime" ADD CONSTRAINT "ShowTime_times_check" CHECK ("endsAt" > "startsAt" AND ("intervalAt" IS NULL OR ("intervalAt" > "startsAt" AND "intervalAt" < "endsAt")));
ALTER TABLE "ShowTime" ADD CONSTRAINT "ShowTime_cutoff_check" CHECK ("orderCutoffMin" BETWEEN 0 AND 120);
ALTER TABLE "ChannelRequest" ADD CONSTRAINT "ChannelRequest_seat_timing_check" CHECK ("seatTiming" IS NULL OR "seatTiming" IN ('NOW', 'INTERVAL', 'COUNTER'));
ALTER TABLE "ChannelRequest" ADD CONSTRAINT "ChannelRequest_pickup_token_check" CHECK ("pickupToken" IS NULL OR "pickupToken" > 0);
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_seat_number_check" CHECK ("seatNumber" IS NULL OR "seatNumber" > 0);
