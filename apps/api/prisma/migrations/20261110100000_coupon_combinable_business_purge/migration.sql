-- P2 gap 4: combinable coupons (owner opt-in; default keeps one offer per bill)
ALTER TABLE "Coupon" ADD COLUMN     "combinable" BOOLEAN NOT NULL DEFAULT false;

-- P2 gap 8b: final export offered before deletion, and the tombstone left after a purge
ALTER TABLE "Business" ADD COLUMN     "finalExportAt" TIMESTAMP(3),
ADD COLUMN     "finalExportFile" TEXT,
ADD COLUMN     "finalExportTokenHash" TEXT;

CREATE TABLE "BusinessTombstone" (
    "id" TEXT NOT NULL,
    "nameHash" TEXT NOT NULL,
    "businessCreatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deleteAfter" TIMESTAMP(3) NOT NULL,
    "finalExportAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "rowCounts" JSONB NOT NULL DEFAULT '{}',
    "filesDeleted" INTEGER NOT NULL DEFAULT 0,
    "filesFailed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BusinessTombstone_pkey" PRIMARY KEY ("id")
);

-- Platform-only table: no hotel can read it; platform console (app.platform) and platform jobs (bypass) can.
ALTER TABLE "BusinessTombstone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessTombstone" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "BusinessTombstone" USING (canavo_rls_bypass() OR canavo_platform()) WITH CHECK (canavo_rls_bypass() OR canavo_platform());
