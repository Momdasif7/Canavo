-- Per-store integrations (Razorpay, SMTP, MSG91 SMS, WhatsApp) managed by each owner in Settings → Integrations.
-- Secrets are AES-256-GCM ciphertexts written by the API (lib/crypto.ts, DATA_ENCRYPTION_KEY).

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('RAZORPAY', 'SMTP', 'SMS', 'WHATSAPP');

-- CreateTable
CREATE TABLE "BusinessIntegration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "webhookKey" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessIntegration_webhookKey_key" ON "BusinessIntegration"("webhookKey");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessIntegration_businessId_kind_key" ON "BusinessIntegration"("businessId", "kind");

-- AddForeignKey
ALTER TABLE "BusinessIntegration" ADD CONSTRAINT "BusinessIntegration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security: a business sees only its own integrations. The Razorpay webhook (no login) finds the
-- business by webhookKey with the platform (bypass) client, then works inside that business.
ALTER TABLE "BusinessIntegration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessIntegration" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BusinessIntegration";
CREATE POLICY tenant_isolation ON "BusinessIntegration" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());

-- Move each business's WhatsApp setup out of the key-value Setting table (no RLS) into its integration row.
-- The encrypted tokens are copied as they are (same key, same format); nothing is decrypted here.
SELECT set_config('app.bypass_rls', 'on', false);

INSERT INTO "BusinessIntegration" ("id", "businessId", "kind", "enabled", "config", "secrets", "createdAt", "updatedAt")
SELECT
  'migwa' || md5(s."scope" || ':whatsapp'),
  s."scope",
  'WHATSAPP',
  true,
  jsonb_strip_nulls(jsonb_build_object(
    'provider', COALESCE(s."value"->>'provider', 'NONE'),
    'meta', CASE WHEN jsonb_typeof(s."value"->'meta') = 'object' THEN (s."value"->'meta') - 'accessTokenEnc' END,
    'wati', CASE WHEN jsonb_typeof(s."value"->'wati') = 'object' THEN (s."value"->'wati') - 'tokenEnc' END,
    'templates', CASE WHEN jsonb_typeof(s."value"->'templates') = 'object' THEN s."value"->'templates' END,
    'autoDeliveryUpdates', COALESCE((s."value"->>'autoDeliveryUpdates')::boolean, false),
    'staffAlerts', COALESCE((s."value"->>'staffAlerts')::boolean, false)
  )),
  jsonb_strip_nulls(jsonb_build_object(
    'metaAccessToken', s."value"#>>'{meta,accessTokenEnc}',
    'watiToken', s."value"#>>'{wati,tokenEnc}'
  )),
  s."updatedAt",
  s."updatedAt"
FROM "Setting" s
JOIN "Business" b ON b."id" = s."scope"
WHERE s."key" = 'whatsapp.config' AND jsonb_typeof(s."value") = 'object'
ON CONFLICT ("businessId", "kind") DO NOTHING;

DELETE FROM "Setting" s WHERE s."key" = 'whatsapp.config' AND EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = s."scope");

SELECT set_config('app.bypass_rls', '', false);
