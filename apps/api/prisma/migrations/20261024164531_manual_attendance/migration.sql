-- AlterTable
ALTER TABLE "StaffAttendance" ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "markedById" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'SELF',
ALTER COLUMN "clockInLat" DROP NOT NULL,
ALTER COLUMN "clockInLng" DROP NOT NULL;

