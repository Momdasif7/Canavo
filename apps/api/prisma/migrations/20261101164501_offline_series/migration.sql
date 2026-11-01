-- CreateTable
CREATE TABLE "OfflineSeries" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "lastSeqByFy" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineSeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfflineSeries_outletId_deviceId_key" ON "OfflineSeries"("outletId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineSeries_outletId_code_key" ON "OfflineSeries"("outletId", "code");


ALTER TABLE "OfflineSeries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfflineSeries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OfflineSeries";
CREATE POLICY tenant_isolation ON "OfflineSeries" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
