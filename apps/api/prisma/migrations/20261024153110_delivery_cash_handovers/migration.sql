-- CreateTable
CREATE TABLE "DeliveryCashHandover" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryCashHandover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryCashHandover_outletId_agentId_receivedAt_idx" ON "DeliveryCashHandover"("outletId", "agentId", "receivedAt");


-- Backfill: earlier "settle" actions become handover records (one per agent, outlet and settlement time).
INSERT INTO "DeliveryCashHandover" ("id", "outletId", "agentId", "amount", "note", "receivedById", "receivedAt", "createdAt", "updatedAt")
SELECT 'hov_' || md5(d."outletId" || p."collectedById" || d."cashSettledAt"::text), d."outletId", p."collectedById", SUM(p."amount"),
       'Migrated from earlier cash settlement', COALESCE(d."cashSettledById", p."collectedById"), d."cashSettledAt", NOW(), NOW()
FROM "Delivery" d
JOIN "Payment" p ON p."orderId" = d."orderId" AND p."mode" = 'CASH' AND p."status" = 'SUCCESS' AND p."collectedById" IS NOT NULL
WHERE d."cashSettledAt" IS NOT NULL
GROUP BY d."outletId", p."collectedById", d."cashSettledAt", d."cashSettledById";
