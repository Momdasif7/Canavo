-- THEATRE runner board: when a seat order's food was ready and when it was handed over (works without the KOT module).
-- AlterTable
ALTER TABLE "ChannelRequest" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3);

