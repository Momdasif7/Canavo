-- QA Phase 7: at most one OPEN running tab per table (like "CashShift_one_open_per_outlet").
-- openSession / transfer already lock the table row and check; this makes the rule hold for every
-- writer. Partial indexes are not modelled by Prisma (prisma migrate diff ignores it).
CREATE UNIQUE INDEX IF NOT EXISTS "TableSession_one_open_per_table" ON "TableSession"("tableId") WHERE "status" = 'OPEN';
