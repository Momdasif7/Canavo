-- AlterTable
ALTER TABLE "StaffAttendance" ADD COLUMN     "clockInAccuracy" INTEGER,
ADD COLUMN     "clockInFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "clockInMocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "clockInSelfieUrl" TEXT;

