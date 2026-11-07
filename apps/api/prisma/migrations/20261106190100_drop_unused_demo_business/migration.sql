-- QA Phase 7 (dbc R1): 20261004124322_multi_business_tax inserted an ACTIVE "Demo Hotel" (biz_demo) and
-- its 5 tax rates into every database, production included. Remove it only where nothing uses it:
-- no outlets, users, menu, customers or inventory. Development databases that use the demo hotel keep it
-- (and the seed recreates it when needed).
SELECT set_config('app.bypass_rls', 'on', false);

DELETE FROM "Business" b
WHERE b."id" = 'biz_demo'
  AND NOT EXISTS (SELECT 1 FROM "Outlet" WHERE "businessId" = b."id")
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "businessId" = b."id")
  AND NOT EXISTS (SELECT 1 FROM "MenuItem" WHERE "businessId" = b."id")
  AND NOT EXISTS (SELECT 1 FROM "Customer" WHERE "businessId" = b."id")
  AND NOT EXISTS (SELECT 1 FROM "InventoryItem" WHERE "businessId" = b."id");

SELECT set_config('app.bypass_rls', '', false);
