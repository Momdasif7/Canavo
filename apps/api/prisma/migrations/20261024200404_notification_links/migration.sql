-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "overdueNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "link" TEXT,
ADD COLUMN     "outletId" TEXT;

