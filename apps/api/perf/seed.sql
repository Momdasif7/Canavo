-- QA Phase 13 load-test dataset (extends test/db/perf-seed.sql to SaaS scale). THROWAWAY database only:
--   createdb canavo_perf && DATABASE_URL=…/canavo_perf npx prisma migrate deploy
--   psql -v ON_ERROR_STOP=1 -d canavo_perf -f perf/seed.sql
-- 50 hotels (1 outlet each) / 1,000 staff / 6,000 menu items / 200k customers /
-- 1M orders over 365 days (busy hotels weighted) / ~3.5M order lines / ~1M payments / ~800k KOTs /
-- 200k deliveries / 300k inventory transactions / 500k audit logs / 100k notifications / ~310k attendance rows.
-- Every staff member logs in as u<outlet>_<n>@perf.local / Perf@12345 (bcrypt cost 10, as the app hashes);
-- n=1 owner, 2..8 cashiers, 9..14 kitchen, 15..20 delivery.
SET app.bypass_rls = 'on';
SET synchronous_commit = off;
SET maintenance_work_mem = '256MB';
SELECT setseed(0.13);

INSERT INTO "Business"(id, name, "updatedAt", modules)
SELECT 'biz'||b, 'Hotel '||b, now(), '{BILLING,KOT,TABLES,DELIVERY,RESERVATIONS,INVENTORY,CUSTOMERS,OFFERS,ATTENDANCE,REPORTS,CANTEEN,CHANNELS}'
FROM generate_series(1,50) b;

INSERT INTO "Outlet"(id, name, "stateCode", "updatedAt", "businessId", "deliveryEnabled")
SELECT 'out'||g, 'Outlet '||g, '33', now(), 'biz'||g, true FROM generate_series(1,50) g;

INSERT INTO "User"(id, name, phone, email, "passwordHash", role, "updatedAt", "businessId")
SELECT 'usr'||o||'_'||u, 'Staff '||o||'/'||u, '9'||lpad((o*100+u)::text, 9, '0'), 'u'||o||'_'||u||'@perf.local',
       '$2b$10$OZyLvpoPs.GL2p6dLpXba.XLocWosPcVWzUxVWQtiJPRcCtXOmlVi',
       (CASE WHEN u=1 THEN 'BUSINESS_OWNER' WHEN u<=8 THEN 'CASHIER' WHEN u<=14 THEN 'KITCHEN' ELSE 'DELIVERY' END)::"Role",
       now(), 'biz'||o
FROM generate_series(1,50) o, generate_series(1,20) u;
INSERT INTO "UserOutlet"("userId","outletId") SELECT 'usr'||o||'_'||u, 'out'||o FROM generate_series(1,50) o, generate_series(1,20) u;

-- menu: 12 categories x 120 items per hotel
INSERT INTO "MenuCategory"(id, name, "businessId") SELECT 'cat'||b||'_'||c, 'Cat '||c, 'biz'||b FROM generate_series(1,50) b, generate_series(1,12) c;
INSERT INTO "MenuItem"(id, name, "categoryId", price, "gstRate", "updatedAt", "businessId")
SELECT 'mi'||b||'_'||i, 'Item '||b||'/'||i, 'cat'||b||'_'||(1+i%12), 1000 + (i*137)%30000, 5, now(), 'biz'||b
FROM generate_series(1,50) b, generate_series(1,120) i;

-- customers: 4,000 per hotel
INSERT INTO "Customer"(id, phone, name, "updatedAt", "businessId", "lastVisitAt", "totalSpend", "visitCount", "createdAt")
SELECT 'cus'||b||'_'||g, '8'||lpad((b*10000+g)::text, 9, '0'), 'Customer '||g, now(), 'biz'||b,
       now() - random() * interval '365 days', (random()*500000)::int, (random()*50)::int, now() - random() * interval '500 days'
FROM generate_series(1,50) b, generate_series(1,4000) g;

-- orders: 1M over 365 days; outlet = 1 + floor(50 * u^1.6) so outlet 1 is the busiest (~75k bills/yr) and 50 the quietest
CREATE TEMP TABLE o_src AS
SELECT g AS n, (1 + floor(50 * power(random(), 1.6)))::int AS o,
       now() - random() * interval '365 days' AS ts, random() AS r2, random() AS r3
FROM generate_series(1,1000000) g;

INSERT INTO "Order"(id, "outletId", "cashierId", "invoiceNumber", "documentType", "orderType", status, subtotal, discount, "taxableValue",
  "serviceCharge", cgst, sgst, igst, "roundOff", "grandTotal", "taxBreakup", "createdAt", "updatedAt", "paidAt", "cancelledAt",
  "customerId", "customerName", "customerPhone", channel, "tableLabel")
SELECT 'ord'||n, 'out'||o, 'usr'||o||'_'||(2 + n%7), 'INV-'||n, 'TAX_INVOICE',
  (CASE WHEN r2<0.5 THEN 'DINE_IN' WHEN r2<0.8 THEN 'TAKEAWAY' ELSE 'DELIVERY' END)::"OrderType",
  (CASE WHEN ts > now() - interval '1 day' AND r3 < 0.3 THEN 'OPEN' WHEN r3 < 0.03 THEN 'CANCELLED' ELSE 'PAID' END)::"OrderStatus",
  10000 + n%40000, 0, 10000 + n%40000, 0, (10000 + n%40000)/40, (10000 + n%40000)/40, 0, 0, 10000 + n%40000 + (10000 + n%40000)/20,
  '[]'::jsonb, ts, ts,
  CASE WHEN r3 >= 0.03 THEN ts + interval '20 min' END, CASE WHEN r3 < 0.03 THEN ts + interval '5 min' END,
  CASE WHEN r2 < 0.4 THEN 'cus'||o||'_'||(1 + n%4000) END,
  CASE WHEN r2 < 0.4 THEN 'Customer' END, CASE WHEN r2 < 0.4 THEN '8000000000' END,
  CASE WHEN r2 > 0.9 THEN (ARRAY['SWIGGY','ZOMATO','WEBSITE'])[1 + n%3] ELSE 'POS' END,
  CASE WHEN r2 < 0.5 THEN 'T'||(1+n%20) END
FROM o_src;

INSERT INTO "OrderItem"(id, "orderId", "menuItemId", name, quantity, "unitPrice", "gstRate", "hsnCode", discount, "taxableValue",
  "serviceCharge", cgst, sgst, igst, total)
SELECT 'oi'||s.n||'_'||k, 'ord'||s.n, 'mi'||s.o||'_'||(1 + (s.n*7 + k*13)%120),
  'Item', 1 + k%3, 5000, 5, '996331', 0, 5000, 0, 125, 125, 0, 5250
FROM o_src s, generate_series(1, 1 + (s.n % 6)) k;

INSERT INTO "Payment"(id, "orderId", mode, amount, status, "createdAt", "collectedById")
SELECT 'pay'||n, 'ord'||n, (ARRAY['CASH','UPI','CARD','UPI'])[1 + n%4]::"PaymentMode", 10000 + n%40000, 'SUCCESS', ts + interval '20 min', 'usr'||o||'_2'
FROM o_src WHERE r3 >= 0.03 AND NOT (ts > now() - interval '1 day' AND r3 < 0.3);

INSERT INTO "KotTicket"(id, "outletId", "orderId", "kotNumber", station, status, items, "createdAt", "updatedAt")
SELECT 'kot'||n, 'out'||o, 'ord'||n, n%1000, 'MAIN',
  (CASE WHEN ts > now() - interval '1 day' THEN (ARRAY['RECEIVED','PREPARING','READY','SERVED'])[1 + n%4] ELSE 'SERVED' END)::"KotStatus",
  '[]'::jsonb, ts, ts
FROM o_src WHERE r2 < 0.8;

INSERT INTO "Delivery"(id, "orderId", "outletId", status, "customerName", "customerPhone", address, "createdAt", "updatedAt", "agentId")
SELECT 'del'||n, 'ord'||n, 'out'||o,
  (CASE WHEN ts > now() - interval '1 day' THEN (ARRAY['PENDING','ACCEPTED','PREPARING','OUT_FOR_DELIVERY'])[1 + n%4] ELSE 'DELIVERED' END)::"DeliveryStatus",
  'C', '8000000000', 'Addr', ts, ts, 'usr'||o||'_'||(15 + n%6)
FROM o_src WHERE r2 >= 0.8;

INSERT INTO "InventoryItem"(id, name, unit, "updatedAt", "businessId", "reorderLevel")
SELECT 'inv'||b||'_'||i, 'Raw '||i, 'KG', now(), 'biz'||b, 5 FROM generate_series(1,50) b, generate_series(1,60) i;
INSERT INTO "InventoryStock"("outletId","inventoryItemId",quantity,"updatedAt")
SELECT 'out'||o, 'inv'||o||'_'||i, random()*100, now() FROM generate_series(1,50) o, generate_series(1,60) i;
INSERT INTO "InventoryTransaction"(id, "outletId", "inventoryItemId", type, quantity, "balanceAfter", "createdAt", "refType", "refId")
SELECT 'itx'||g, 'out'||o, 'inv'||o||'_'||(1 + g%60),
  (CASE WHEN g%10=0 THEN 'PURCHASE' WHEN g%25=0 THEN 'WASTAGE' ELSE 'SALE' END)::"InventoryTxnType", -1, 50,
  now() - random() * interval '365 days', 'ORDER', 'ord'||(1 + g%1000000)
FROM (SELECT g, 1 + floor(random()*50)::int o FROM generate_series(1,300000) g) s;

INSERT INTO "AuditLog"(id, "userId", "outletId", action, entity, "entityId", "createdAt", "businessId")
SELECT 'aud'||g, 'usr'||o||'_2', 'out'||o, (ARRAY['order.create','order.pay','kot.status','menu.update','login'])[1 + g%5], 'Order', 'ord'||(1+g%1000000),
  now() - random() * interval '365 days', 'biz'||o
FROM (SELECT g, 1 + floor(random()*50)::int o FROM generate_series(1,500000) g) s;

INSERT INTO "Notification"(id, "userId", title, body, kind, read, "createdAt", "outletId")
SELECT 'ntf'||g, 'usr'||(1 + g%50)||'_'||(1 + (g/50)%20), 'T', 'B', 'ORDER', random() < 0.8, now() - random() * interval '120 days', 'out'||(1 + g%50)
FROM generate_series(1,100000) g;

INSERT INTO "StaffAttendance"(id, "userId", "outletId", "workDate", "clockInAt", "clockInDistance", "clockOutAt", "workedMinutes")
SELECT 'att'||o||'_'||u||'_'||d, 'usr'||o||'_'||u, 'out'||o, to_char(current_date - d, 'YYYY-MM-DD'),
  (current_date - d) + time '09:00', 10, (current_date - d) + time '18:00', 540
FROM generate_series(1,50) o, generate_series(1,20) u, generate_series(1,365) d WHERE random() < 0.85;

DROP TABLE o_src;

-- online ordering page for every hotel: /public/o/hotel-<n>
UPDATE "Outlet" SET "publicSlug" = 'hotel-'||substr(id,4), storefront = '{"onlineOrdering":true,"menuView":true}'::jsonb;
-- (afterwards, outside a transaction, with docker's 64 MB /dev/shm:)
--   SET max_parallel_maintenance_workers = 0; VACUUM ANALYZE;
