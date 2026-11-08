# CANAVO operations

Production topology (see [render.yaml](../../render.yaml), [DEPLOYMENT.md](../deployment/DEPLOYMENT.md)):
`canavo-api` (Docker, Express + Socket.io, `/ready` health check) · `canavo-worker` (pg-boss jobs, daily backup) ·
`canavo-db` (PostgreSQL 16) · optional Redis (needed for >1 API instance) · web on Vercel · off-site backups on S3/R2/B2.

| Doc | What |
|---|---|
| [MONITORING.md](MONITORING.md) | Metrics at `/metrics`, alert list and thresholds, DB pool sizing |
| [LOGGING.md](LOGGING.md) | Structured logs, request ids, redaction, retention, error-tracker (Sentry) hook |
| [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | Backup schedule, off-site copies, restore drill evidence, RPO / RTO |
| [RUNBOOK_DEPLOY.md](RUNBOOK_DEPLOY.md) | Release procedure |
| [RUNBOOK_ROLLBACK.md](RUNBOOK_ROLLBACK.md) | Rolling back web, API/worker, database |
| [RUNBOOK_INCIDENT.md](RUNBOOK_INCIDENT.md) | Severity, triage, comms, common incidents |
| [UPLOADS_STORAGE.md](UPLOADS_STORAGE.md) | Uploaded images: current state and object-storage plan |
| [AUDIT_LOG_RETENTION.md](AUDIT_LOG_RETENTION.md) | Audit-log growth and retention / archive plan |

Related: [migration runbook](../qa/phase-7/migration-runbook.md) · [performance results](../qa/phase-13-performance.md) ·
[production readiness](../qa/PRODUCTION_READINESS.md).
