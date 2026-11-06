-- QA Phase 7: "who is clocked in now" (clockOutAt IS NULL, outlets overview / reminders) scanned the
-- outlet's whole attendance history (13 ms -> 0.1 ms on the perf dataset). Built CONCURRENTLY
-- (own migration, outside a transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "StaffAttendance_outletId_clockOutAt_idx" ON "StaffAttendance"("outletId", "clockOutAt");
