-- CreateTable
CREATE TABLE "OutboxEvent" (
    "seq" BIGSERIAL NOT NULL,
    "businessId" TEXT,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_deliveredAt_failedAt_availableAt_idx" ON "OutboxEvent"("deliveredAt", "failedAt", "availableAt");

