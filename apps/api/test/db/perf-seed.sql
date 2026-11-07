-- Phase 7 (dbb) query-plan dataset. Run as the database owner on a THROWAWAY database
-- (e.g. canavo_dbb_perf) after `prisma migrate deploy`:
--   psql -v ON_ERROR_STOP=1 -d canavo_dbb_perf -f test/db/perf-seed.sql
-- 3 businesses / 10 outlets / 300k orders over 400 days / ~1M order items / payments / KOTs /
-- 200k inventory transactions / 300k audit logs / 60k customers / 100k notifications / attendance.
SET app.bypass_rls = 'on';
SET synchronous_commit = off;
SELECT setseed(0.42);

INSERT INTO "Business"(id, name, "updatedAt", modules)
SELECT b, n, now(), '{BILLING,KOT,TABLES,DELIVERY,RESERVATIONS,INVENTORY,CUSTOMERS,OFFERS,ATTENDANCE,REPORTS,CANTEEN,CHANNELS}'
FROM (VALUES ('biz1','Big Chain'),('biz2','Mid Cafe'),('biz3','Small Canteen')) v(b, n);

-- outlets: biz1 = out1..out5, biz2 = out6..out8, biz3 = out9..out10
INSERT INTO "Outlet"(id, name, "stateCode", "updatedAt", "businessId", "deliveryEnabled")
SELECT 'out'||g, 'Outlet '||g, '33', now(), CASE WHEN g<=5 THEN 'biz1' WHEN g<=8 THEN 'biz2' ELSE 'biz3' END, true
FROM generate_series(1,10) g;

-- staff: 20 per outlet (owner per business + cashiers/kitchen/delivery)
INSERT INTO "User"(id, name, phone, role, "updatedAt", "businessId")
SELECT 'usr'||o||'_'||u, 'Staff '||o||'/'||u, '9'||lpad((o*100+u)::text, 9, '0'),
       (CASE WHEN u=1 THEN 'BUSINESS_OWNER' WHEN u<=8 THEN 'CASHIER' WHEN u<=14 THEN 'KITCHEN' ELSE 'DELIVERY' END)::"Role",
       now(), CASE WHEN o<=5 THEN 'biz1' WHEN o<=8 THEN 'biz2' ELSE 'biz3' END
FROM generate_series(1,10) o, generate_series(1,20) u;
INSERT INTO "UserOutlet"("userId","outletId") SELECT 'usr'||o||'_'||u, 'out'||o FROM generate_series(1,10) o, generate_series(1,20) u;

-- menu: 10 categories x 20 items per business
INSERT INTO "MenuCategory"(id, name, "businessId") SELECT 'cat'||b||'_'||c, 'Cat '||c, 'biz'||b FROM generate_series(1,3) b, generate_series(1,10) c;
INSERT INTO "MenuItem"(id, name, "categoryId", price, "gstRate", "updatedAt", "businessId")
SELECT 'mi'||b||'_'||i, 'Item '||b||'/'||i, 'cat'||b||'_'||(1+i%10), 1000 + (i*137)%30000, 5, now(), 'biz'||b
FROM generate_series(1,3) b, generate_series(1,200) i;

-- customers: 30k / 20k / 10k
INSERT INTO "Customer"(id, phone, name, "updatedAt", "businessId", "lastVisitAt", "totalSpend", "visitCount", "createdAt")
SELECT 'cus'||g, '8'||lpad(g::text, 9, '0'), 'Customer '||g, now(), CASE WHEN g<=30000 THEN 'biz1' WHEN g<=50000 THEN 'biz2' ELSE 'biz3' END,
       now() - (random()*400 || ' days')::interval, (random()*500000)::int, (random()*50)::int, now() - (random()*500 || ' days')::interval
FROM generate_series(1,60000) g;

-- orders: 300k over 400 days, outlet-weighted (big chain gets ~60%)
CREATE TEMP TABLE o_src AS
SELECT g AS n,
       ('out'|| (CASE WHEN r < 0.6 THEN 1 + floor(random()*5) WHEN r < 0.9 THEN 6 + floor(random()*3) ELSE 9 + floor(random()*2) END)::int) AS outlet,
       now() - (random()*400 || ' days')::interval AS ts,
       random() AS r2, random() AS r3
FROM (SELECT g, random() r FROM generate_series(1,300000) g) s;

INSERT INTO "Order"(id, "outletId", "cashierId", "invoiceNumber", "documentType", "orderType", status, subtotal, discount, "taxableValue",
  "serviceCharge", cgst, sgst, igst, "roundOff", "grandTotal", "taxBreakup", "createdAt", "updatedAt", "paidAt", "cancelledAt",
  "customerId", "customerName", "customerPhone", channel, "tableLabel")
SELECT 'ord'||n, outlet, 'usr'||substr(outlet,4)||'_'||(2 + n%7), 'INV-'||n, 'TAX_INVOICE',
  (CASE WHEN r2<0.5 THEN 'DINE_IN' WHEN r2<0.8 THEN 'TAKEAWAY' ELSE 'DELIVERY' END)::"OrderType",
  (CASE WHEN ts > now() - interval '1 day' AND r3 < 0.3 THEN 'OPEN' WHEN r3 < 0.03 THEN 'CANCELLED' ELSE 'PAID' END)::"OrderStatus",
  10000 + n%40000, 0, 10000 + n%40000, 0, (10000 + n%40000)/40, (10000 + n%40000)/40, 0, 0, 10000 + n%40000 + (10000 + n%40000)/20,
  '[]'::jsonb, ts, ts,
  CASE WHEN r3 >= 0.03 THEN ts + interval '20 min' END, CASE WHEN r3 < 0.03 THEN ts + interval '5 min' END,
  CASE WHEN r2 < 0.4 THEN 'cus'|| (CASE substr(outlet,4)::int WHEN 9 THEN 50001 + n%10000 WHEN 10 THEN 50001 + n%10000 ELSE
       CASE WHEN substr(outlet,4)::int <= 5 THEN 1 + n%30000 ELSE 30001 + n%20000 END END) END,
  CASE WHEN r2 < 0.4 THEN 'Customer' END, CASE WHEN r2 < 0.4 THEN '8000000000' END,
  CASE WHEN r2 > 0.9 THEN (ARRAY['SWIGGY','ZOMATO','WEBSITE'])[1 + n%3] ELSE 'POS' END,
  CASE WHEN r2 < 0.5 THEN 'T'||(1+n%20) END
FROM o_src;

-- ~1M order items (1..6 per order, avg 3.33)
INSERT INTO "OrderItem"(id, "orderId", "menuItemId", name, quantity, "unitPrice", "gstRate", "hsnCode", discount, "taxableValue",
  "serviceCharge", cgst, sgst, igst, total)
SELECT 'oi'||o.n||'_'||k, 'ord'||o.n,
  'mi'|| (CASE WHEN substr(o.outlet,4)::int<=5 THEN 1 WHEN substr(o.outlet,4)::int<=8 THEN 2 ELSE 3 END) ||'_'|| (1 + (o.n*7 + k*13)%200),
  'Item', 1 + k%3, 5000, 5, '996331', 0, 5000, 0, 125, 125, 0, 5250
FROM o_src o, generate_series(1, 1 + (o.n % 6)) k;

-- payments: one per paid order, 5% split into two
INSERT INTO "Payment"(id, "orderId", mode, amount, status, "createdAt", "collectedById")
SELECT 'pay'||n, 'ord'||n, (ARRAY['CASH','UPI','CARD','UPI'])[1 + n%4]::"PaymentMode", 10000 + n%40000, 'SUCCESS', ts + interval '20 min', 'usr'||substr(outlet,4)||'_2'
FROM o_src WHERE r3 >= 0.03 AND NOT (ts > now() - interval '1 day' AND r3 < 0.3);
INSERT INTO "Payment"(id, "orderId", mode, amount, status, "createdAt")
SELECT 'pay'||n||'b', 'ord'||n, 'CASH', 500, 'SUCCESS', ts + interval '21 min' FROM o_src WHERE r3 >= 0.03 AND n%20=0;

-- KOTs: one per dine-in/takeaway order
INSERT INTO "KotTicket"(id, "outletId", "orderId", "kotNumber", station, status, items, "createdAt", "updatedAt")
SELECT 'kot'||n, outlet, 'ord'||n, n%1000, 'MAIN',
  (CASE WHEN ts > now() - interval '1 day' THEN (ARRAY['RECEIVED','PREPARING','READY','SERVED'])[1 + n%4] ELSE 'SERVED' END)::"KotStatus",
  '[]'::jsonb, ts, ts
FROM o_src WHERE r2 < 0.8;

-- deliveries for DELIVERY orders
INSERT INTO "Delivery"(id, "orderId", "outletId", status, "customerName", "customerPhone", address, "createdAt", "updatedAt", "agentId")
SELECT 'del'||n, 'ord'||n, outlet,
  (CASE WHEN ts > now() - interval '1 day' THEN (ARRAY['PENDING','ACCEPTED','PREPARING','OUT_FOR_DELIVERY'])[1 + n%4] ELSE 'DELIVERED' END)::"DeliveryStatus",
  'C', '8000000000', 'Addr', ts, ts, 'usr'||substr(outlet,4)||'_'||(15 + n%6)
FROM o_src WHERE r2 >= 0.8;

-- inventory: 150 items per business, stock rows per outlet, 200k transactions
INSERT INTO "InventoryItem"(id, name, unit, "updatedAt", "businessId", "reorderLevel")
SELECT 'inv'||b||'_'||i, 'Raw '||i, 'KG', now(), 'biz'||b, 5 FROM generate_series(1,3) b, generate_series(1,150) i;
INSERT INTO "InventoryStock"("outletId","inventoryItemId",quantity,"updatedAt")
SELECT 'out'||o, 'inv'|| (CASE WHEN o<=5 THEN 1 WHEN o<=8 THEN 2 ELSE 3 END) ||'_'||i, random()*100, now()
FROM generate_series(1,10) o, generate_series(1,150) i;
INSERT INTO "InventoryTransaction"(id, "outletId", "inventoryItemId", type, quantity, "balanceAfter", "createdAt", "refType", "refId")
SELECT 'itx'||g, 'out'||o, 'inv'|| (CASE WHEN o<=5 THEN 1 WHEN o<=8 THEN 2 ELSE 3 END) ||'_'||(1 + g%150),
  (CASE WHEN g%10=0 THEN 'PURCHASE' WHEN g%25=0 THEN 'WASTAGE' ELSE 'SALE' END)::"InventoryTxnType", -1, 50,
  now() - (random()*400 || ' days')::interval, 'ORDER', 'ord'||(1 + g%300000)
FROM (SELECT g, 1 + floor(random()*10)::int o FROM generate_series(1,200000) g) s;

-- audit logs: 300k
INSERT INTO "AuditLog"(id, "userId", "outletId", action, entity, "entityId", "createdAt", "businessId")
SELECT 'aud'||g, 'usr'||o||'_2', 'out'||o, (ARRAY['order.create','order.pay','kot.status','menu.update','login'])[1 + g%5], 'Order', 'ord'||(1+g%300000),
  now() - (random()*400 || ' days')::interval, CASE WHEN o<=5 THEN 'biz1' WHEN o<=8 THEN 'biz2' ELSE 'biz3' END
FROM (SELECT g, 1 + floor(random()*10)::int o FROM generate_series(1,300000) g) s;

-- notifications: 100k across all staff
INSERT INTO "Notification"(id, "userId", title, body, kind, read, "createdAt", "outletId")
SELECT 'ntf'||g, 'usr'||(1 + g%10)||'_'||(1 + (g/10)%20), 'T', 'B', 'ORDER', random() < 0.8, now() - (random()*120 || ' days')::interval, 'out'||(1 + g%10)
FROM generate_series(1,100000) g;

-- attendance: 400 days x 200 staff (one row per staff per day, ~85% present)
INSERT INTO "StaffAttendance"(id, "userId", "outletId", "workDate", "clockInAt", "clockInDistance", "clockOutAt", "workedMinutes")
SELECT 'att'||o||'_'||u||'_'||d, 'usr'||o||'_'||u, 'out'||o, to_char(current_date - d, 'YYYY-MM-DD'),
  (current_date - d) + time '09:00', 10, (current_date - d) + time '18:00', 540
FROM generate_series(1,10) o, generate_series(1,20) u, generate_series(0,399) d WHERE random() < 0.85;

DROP TABLE o_src;

-- login for test/db/perf-capture.ts: owner1@perf.local / Perf@12345 (bcrypt cost 4)
UPDATE "User" SET email = 'owner1@perf.local', "passwordHash" = '$2b$04$BxWzip0OqIwyPwfwUes2TeNc.zcLgA/N5dbk3PAsZK2E7Fgp9tai.' WHERE id = 'usr1_1';
