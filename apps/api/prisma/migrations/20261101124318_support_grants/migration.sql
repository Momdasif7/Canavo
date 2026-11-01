-- CreateTable
CREATE TABLE "SupportGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportGrant_businessId_expiresAt_idx" ON "SupportGrant"("businessId", "expiresAt");

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security: the hotel sees its own grants; the platform reads them with the bypass client
ALTER TABLE "SupportGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportGrant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SupportGrant";
CREATE POLICY tenant_isolation ON "SupportGrant" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
