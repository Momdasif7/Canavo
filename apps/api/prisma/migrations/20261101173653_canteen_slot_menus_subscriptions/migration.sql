-- CreateEnum
CREATE TYPE "MealSubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "servedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MealSlotItem" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealSlotItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealSubscription" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "daysOfWeek" INTEGER[],
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "pricePerMeal" INTEGER NOT NULL,
    "mealCount" INTEGER NOT NULL,
    "status" "MealSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "orderId" TEXT,
    "creditNoteId" TEXT,
    "refundedMeals" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealSubscriptionSkip" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealSubscriptionSkip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealSubscriptionMeal" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealSubscriptionMeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MealSlotItem_menuItemId_idx" ON "MealSlotItem"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "MealSlotItem_slotId_menuItemId_key" ON "MealSlotItem"("slotId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "MealSubscription_orderId_key" ON "MealSubscription"("orderId");

-- CreateIndex
CREATE INDEX "MealSubscription_outletId_status_idx" ON "MealSubscription"("outletId", "status");

-- CreateIndex
CREATE INDEX "MealSubscription_customerId_idx" ON "MealSubscription"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "MealSubscriptionSkip_subscriptionId_date_key" ON "MealSubscriptionSkip"("subscriptionId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MealSubscriptionMeal_orderId_key" ON "MealSubscriptionMeal"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MealSubscriptionMeal_subscriptionId_date_key" ON "MealSubscriptionMeal"("subscriptionId", "date");

-- AddForeignKey
ALTER TABLE "MealSlotItem" ADD CONSTRAINT "MealSlotItem_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "MealSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSlotItem" ADD CONSTRAINT "MealSlotItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSubscription" ADD CONSTRAINT "MealSubscription_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "MealSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSubscription" ADD CONSTRAINT "MealSubscription_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSubscriptionSkip" ADD CONSTRAINT "MealSubscriptionSkip_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "MealSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealSubscriptionMeal" ADD CONSTRAINT "MealSubscriptionMeal_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "MealSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern)
ALTER TABLE "MealSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealSubscription" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealSubscription";
CREATE POLICY tenant_isolation ON "MealSubscription" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "MealSlotItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealSlotItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealSlotItem";
CREATE POLICY tenant_isolation ON "MealSlotItem" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSlot" parent WHERE parent."id" = "MealSlotItem"."slotId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSlot" parent WHERE parent."id" = "MealSlotItem"."slotId"));
ALTER TABLE "MealSubscriptionSkip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealSubscriptionSkip" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealSubscriptionSkip";
CREATE POLICY tenant_isolation ON "MealSubscriptionSkip" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSubscription" parent WHERE parent."id" = "MealSubscriptionSkip"."subscriptionId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSubscription" parent WHERE parent."id" = "MealSubscriptionSkip"."subscriptionId"));
ALTER TABLE "MealSubscriptionMeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealSubscriptionMeal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealSubscriptionMeal";
CREATE POLICY tenant_isolation ON "MealSubscriptionMeal" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSubscription" parent WHERE parent."id" = "MealSubscriptionMeal"."subscriptionId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MealSubscription" parent WHERE parent."id" = "MealSubscriptionMeal"."subscriptionId"));
