/** Child process of backup-drill: restore one backup file into DATABASE_URL (the drill database). */
import { restoreBackup } from "../src/services/backup";
import { platformPrisma } from "../src/db";

restoreBackup(process.argv[2]!)
  .then((r) => {
    process.stdout.write(`${JSON.stringify({ rows: r.rows, counts: r.counts })}\n`);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => platformPrisma.$disconnect());
