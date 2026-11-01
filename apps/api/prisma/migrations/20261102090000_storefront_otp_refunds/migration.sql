-- AlterTable
ALTER TABLE "ChannelRequest" ADD COLUMN     "creditNoteId" TEXT,
ADD COLUMN     "refundAmount" INTEGER,
ADD COLUMN     "refundError" TEXT,
ADD COLUMN     "refundRef" TEXT,
ADD COLUMN     "refundStatus" TEXT;

-- CreateTable
CREATE TABLE "CustomerOtp" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerOtp_outletId_phone_createdAt_idx" ON "CustomerOtp"("outletId", "phone", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerOtp" ADD CONSTRAINT "CustomerOtp_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "CustomerOtp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerOtp" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CustomerOtp";
CREATE POLICY tenant_isolation ON "CustomerOtp" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
