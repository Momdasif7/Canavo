-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'POS',
ADD COLUMN     "channelOrderId" TEXT;

