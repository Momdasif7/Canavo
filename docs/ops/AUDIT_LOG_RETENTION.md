# Audit log: growth and retention

## Facts (QA Phase 7 [dbd.md](../qa/phase-7/dbd.md), Phase 13)
- Table `AuditLog` (id cuid, businessId, userId, outletId, action, entity, entityId, meta JSON, ip, createdAt); indexes:
  pkey, `(businessId, createdAt)`, `(outletId, createdAt)`, `(entity, entityId)`. FORCE RLS by `businessId`.
- Written in the **same transaction** as the change (a failed bill leaves no audit row).
- Measured: **≈ 2.5 rows per bill** (order.create + one payment.collect per payment call + voids / refunds / settles /
  shifts), **≈ 270 bytes** per row.
- Estimate: 1,000 bills/day/outlet → ~2,500 rows/day → **~0.9 M rows ≈ 250 MB heap + ~150 MB indexes per outlet per year**.
  100 outlets → ~90 M rows / ~40 GB a year. Phase 13's dataset carried 500k audit rows without measurable slowdown.
- **Nothing deletes or archives audit rows today** (no job, no setting). Rows also hold `ip` (personal data).

## Retention policy (proposal — needs product/legal sign-off)
| Age | Where | Access |
|---|---|---|
| 0–13 months | `AuditLog` (hot, indexed) | Audit screen, owners / auditors |
| 13 months – 8 years | Archive: monthly compressed files (JSONL.gz / Parquet) in the off-site bucket, per business | On request (support export) |
| > 8 years | Deleted | — |

8 years covers the GST record-keeping horizon (CGST Act s.36: 72 months after the annual return due date). The `ip` column
can be nulled at archive time (DPDP data minimisation) unless a legal hold applies.

## Implementation plan
| Step | Effort | What |
|---|---|---|
| 1 | S | Audit screen: default date range = last 30 days, no exact `count(*)` over the whole business (dbd R7b). Index `(businessId, userId, createdAt)` for the user filter (R7c, `CONCURRENTLY`, own migration). Mask gift-card codes in `gift_card.issue` meta (R7d). |
| 2 | M | Monthly **partitioning** of `AuditLog` on `createdAt` (new partitioned table + copy + swap in a window; Prisma treats it as a normal table; PK becomes `(id, createdAt)`). Old months then leave with `DETACH PARTITION` (instant, no bloat) instead of `DELETE`. |
| 3 | M | Worker job `audit-archive` (monthly, 1st, 03:00 IST): for each month older than 13 months, export rows per business to the bucket, verify row count + checksum, then detach + drop the partition. Metric `canavo_job_runs_total{job="audit-archive"}`; alert on error (MONITORING A7). |
| 4 | S | Restore path: support tool to load one archived month of one business into a scratch table for an investigation. |
| — | Until step 2 | Monitor table size monthly (`SELECT pg_size_pretty(pg_total_relation_size('"AuditLog"'))`) and start step 2 before it passes ~20 GB. |

Platform backups include `AuditLog` in full; with partitions the backup should cover only the hot window plus the archive files.
