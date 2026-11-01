-- Phase 1.1: PostgreSQL Row-Level Security as a backstop under the Prisma tenant filter.
-- The app sets, per transaction (SET LOCAL semantics via set_config(..., true)):
--   app.business_id  the current hotel        -> rows of that hotel only
--   app.platform     'on' for the platform admin console -> platform rows (businessId NULL) only
--   app.bypass_rls   'on' only for platform/infrastructure code (platform client, jobs, scripts)
-- No setting at all = no rows (fail closed). Superusers bypass RLS by design (local docker);
-- production connects as a normal role, so policies are enforced (FORCE also binds the table owner).

CREATE OR REPLACE FUNCTION canavo_rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;
CREATE OR REPLACE FUNCTION canavo_platform() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$;
CREATE OR REPLACE FUNCTION canavo_business() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.business_id', true), '') $$;
-- Outlets of the current hotel, evaluated once per statement when wrapped in (SELECT ...).
CREATE OR REPLACE FUNCTION canavo_outlets() RETURNS text[] LANGUAGE sql STABLE AS
  $$ SELECT coalesce(array_agg("id"), '{}') FROM "Outlet" WHERE "businessId" = canavo_business() $$;


-- Tables with businessId
ALTER TABLE "Outlet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Outlet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Outlet";
CREATE POLICY tenant_isolation ON "Outlet" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "MenuCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MenuCategory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MenuCategory";
CREATE POLICY tenant_isolation ON "MenuCategory" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "MenuItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MenuItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MenuItem";
CREATE POLICY tenant_isolation ON "MenuItem" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Customer";
CREATE POLICY tenant_isolation ON "Customer" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "Offer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Offer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Offer";
CREATE POLICY tenant_isolation ON "Offer" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "Coupon" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Coupon" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Coupon";
CREATE POLICY tenant_isolation ON "Coupon" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "InventoryItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InventoryItem";
CREATE POLICY tenant_isolation ON "InventoryItem" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "Vendor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Vendor" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Vendor";
CREATE POLICY tenant_isolation ON "Vendor" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "TaxRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaxRate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TaxRate";
CREATE POLICY tenant_isolation ON "TaxRate" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "User";
CREATE POLICY tenant_isolation ON "User" USING (canavo_rls_bypass() OR ("businessId" = canavo_business() OR ("businessId" IS NULL AND canavo_platform()))) WITH CHECK (canavo_rls_bypass() OR ("businessId" = canavo_business() OR ("businessId" IS NULL AND canavo_platform())));
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditLog";
CREATE POLICY tenant_isolation ON "AuditLog" USING (canavo_rls_bypass() OR ("businessId" = canavo_business() OR ("businessId" IS NULL AND canavo_platform()))) WITH CHECK (canavo_rls_bypass() OR ("businessId" = canavo_business() OR ("businessId" IS NULL AND canavo_platform())));

-- Tables scoped by outlet
ALTER TABLE "UserOutlet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserOutlet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "UserOutlet";
CREATE POLICY tenant_isolation ON "UserOutlet" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "Shift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shift" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Shift";
CREATE POLICY tenant_isolation ON "Shift" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "StaffAttendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffAttendance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StaffAttendance";
CREATE POLICY tenant_isolation ON "StaffAttendance" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "OutletItemOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutletItemOverride" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OutletItemOverride";
CREATE POLICY tenant_isolation ON "OutletItemOverride" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "InvoiceCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceCounter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InvoiceCounter";
CREATE POLICY tenant_isolation ON "InvoiceCounter" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Order";
CREATE POLICY tenant_isolation ON "Order" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "KotTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KotTicket" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KotTicket";
CREATE POLICY tenant_isolation ON "KotTicket" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "DiningArea" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiningArea" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DiningArea";
CREATE POLICY tenant_isolation ON "DiningArea" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "DiningTable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiningTable" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DiningTable";
CREATE POLICY tenant_isolation ON "DiningTable" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "TableSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TableSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TableSession";
CREATE POLICY tenant_isolation ON "TableSession" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "Reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reservation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Reservation";
CREATE POLICY tenant_isolation ON "Reservation" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "DeliveryZone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryZone" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeliveryZone";
CREATE POLICY tenant_isolation ON "DeliveryZone" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "Delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Delivery" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Delivery";
CREATE POLICY tenant_isolation ON "Delivery" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "KhataTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KhataTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KhataTransaction";
CREATE POLICY tenant_isolation ON "KhataTransaction" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "InventoryStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryStock" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InventoryStock";
CREATE POLICY tenant_isolation ON "InventoryStock" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "InventoryTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InventoryTransaction";
CREATE POLICY tenant_isolation ON "InventoryTransaction" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "Purchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Purchase" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Purchase";
CREATE POLICY tenant_isolation ON "Purchase" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "StockAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockAudit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockAudit";
CREATE POLICY tenant_isolation ON "StockAudit" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "ReportSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportSchedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReportSchedule";
CREATE POLICY tenant_isolation ON "ReportSchedule" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "DeliveryCashHandover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryCashHandover" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeliveryCashHandover";
CREATE POLICY tenant_isolation ON "DeliveryCashHandover" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));

-- Child tables: visible when their parent row is visible (the parent's own policy applies)
ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RefreshToken";
CREATE POLICY tenant_isolation ON "RefreshToken" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "RefreshToken"."userId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "RefreshToken"."userId"));
ALTER TABLE "LeaveRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaveRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "LeaveRequest";
CREATE POLICY tenant_isolation ON "LeaveRequest" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "LeaveRequest"."userId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "LeaveRequest"."userId"));
ALTER TABLE "DeviceToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceToken" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeviceToken";
CREATE POLICY tenant_isolation ON "DeviceToken" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "DeviceToken"."userId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "DeviceToken"."userId"));
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Notification";
CREATE POLICY tenant_isolation ON "Notification" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "Notification"."userId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "Notification"."userId"));
ALTER TABLE "ItemVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ItemVariant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ItemVariant";
CREATE POLICY tenant_isolation ON "ItemVariant" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "ItemVariant"."menuItemId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "ItemVariant"."menuItemId"));
ALTER TABLE "ItemAddon" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ItemAddon" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ItemAddon";
CREATE POLICY tenant_isolation ON "ItemAddon" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "ItemAddon"."menuItemId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "ItemAddon"."menuItemId"));
ALTER TABLE "Recipe" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recipe" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Recipe";
CREATE POLICY tenant_isolation ON "Recipe" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "Recipe"."menuItemId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "MenuItem" parent WHERE parent."id" = "Recipe"."menuItemId"));
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderItem";
CREATE POLICY tenant_isolation ON "OrderItem" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Order" parent WHERE parent."id" = "OrderItem"."orderId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Order" parent WHERE parent."id" = "OrderItem"."orderId"));
ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Payment";
CREATE POLICY tenant_isolation ON "Payment" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Order" parent WHERE parent."id" = "Payment"."orderId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Order" parent WHERE parent."id" = "Payment"."orderId"));
ALTER TABLE "TableSessionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TableSessionItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TableSessionItem";
CREATE POLICY tenant_isolation ON "TableSessionItem" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "TableSession" parent WHERE parent."id" = "TableSessionItem"."sessionId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "TableSession" parent WHERE parent."id" = "TableSessionItem"."sessionId"));
ALTER TABLE "LoyaltyTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoyaltyTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "LoyaltyTransaction";
CREATE POLICY tenant_isolation ON "LoyaltyTransaction" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "LoyaltyTransaction"."customerId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "LoyaltyTransaction"."customerId"));
ALTER TABLE "CouponRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CouponRedemption" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CouponRedemption";
CREATE POLICY tenant_isolation ON "CouponRedemption" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Coupon" parent WHERE parent."id" = "CouponRedemption"."couponId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Coupon" parent WHERE parent."id" = "CouponRedemption"."couponId"));
ALTER TABLE "PurchasePayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchasePayment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PurchasePayment";
CREATE POLICY tenant_isolation ON "PurchasePayment" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Purchase" parent WHERE parent."id" = "PurchasePayment"."purchaseId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Purchase" parent WHERE parent."id" = "PurchasePayment"."purchaseId"));
ALTER TABLE "PurchaseItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PurchaseItem";
CREATE POLICY tenant_isolation ON "PurchaseItem" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Purchase" parent WHERE parent."id" = "PurchaseItem"."purchaseId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Purchase" parent WHERE parent."id" = "PurchaseItem"."purchaseId"));
ALTER TABLE "StockAuditLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockAuditLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockAuditLine";
CREATE POLICY tenant_isolation ON "StockAuditLine" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "StockAudit" parent WHERE parent."id" = "StockAuditLine"."auditId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "StockAudit" parent WHERE parent."id" = "StockAuditLine"."auditId"));
ALTER TABLE "StockTransferItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockTransferItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockTransferItem";
CREATE POLICY tenant_isolation ON "StockTransferItem" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "StockTransfer" parent WHERE parent."id" = "StockTransferItem"."transferId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "StockTransfer" parent WHERE parent."id" = "StockTransferItem"."transferId"));

-- Stock transfers move stock between two outlets of the same hotel
ALTER TABLE "StockTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockTransfer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockTransfer";
CREATE POLICY tenant_isolation ON "StockTransfer" USING (canavo_rls_bypass() OR ("fromOutletId" = ANY ((SELECT canavo_outlets())::text[]) OR "toOutletId" = ANY ((SELECT canavo_outlets())::text[]))) WITH CHECK (canavo_rls_bypass() OR ("fromOutletId" = ANY ((SELECT canavo_outlets())::text[]) OR "toOutletId" = ANY ((SELECT canavo_outlets())::text[])));
