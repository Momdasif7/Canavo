-- Gap 3 (background GPS per outlet) + gap 7 (clock-in face check, DPDP consent). Additive, nullable / defaulted: no backfill.
-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "backgroundTracking" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StaffAttendance" ADD COLUMN     "faceCheck" TEXT,
ADD COLUMN     "faceReviewedAt" TIMESTAMP(3),
ADD COLUMN     "faceReviewedById" TEXT,
ADD COLUMN     "faceScore" DOUBLE PRECISION,
ADD COLUMN     "livenessPrompt" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "faceConsentAt" TIMESTAMP(3),
ADD COLUMN     "faceConsentVersion" TEXT,
ADD COLUMN     "faceRefPhotoUrl" TEXT;

