-- CreateEnum
CREATE TYPE "AadhaarMode" AS ENUM ('LAST4', 'FULL');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "aadhaarMode" "AadhaarMode" NOT NULL DEFAULT 'LAST4';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aadhaarConsentAt" TIMESTAMP(3),
ADD COLUMN     "aadhaarConsentById" TEXT,
ADD COLUMN     "aadhaarConsentVersion" TEXT,
ADD COLUMN     "aadhaarLast4" TEXT;


-- Keep today's behaviour for hotels that already store full Aadhaar numbers (rule: no change for
-- existing hotels without their choice). New hotels and hotels without stored numbers keep last 4 only.
-- Row-level security is FORCEd on these tables: this data migration bypasses it explicitly (ADR 0001).
SELECT set_config('app.bypass_rls', 'on', false);
UPDATE "Business" b SET "aadhaarMode" = 'FULL'
  WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."businessId" = b."id" AND u."aadhaarEnc" IS NOT NULL);
SELECT set_config('app.bypass_rls', '', false);
