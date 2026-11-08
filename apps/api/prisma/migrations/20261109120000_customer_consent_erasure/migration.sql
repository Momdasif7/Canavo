-- QA Phase 14 (DPDP Act 2023): customer consent flags and erasure marker.
-- Existing customers start opted OUT: there is no record that they agreed to promotional messages.
ALTER TABLE "Customer" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "consentSource" TEXT,
ADD COLUMN     "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false;
