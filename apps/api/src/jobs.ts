/**
 * Minimal in-process job scheduler. Each module registers its jobs in its own
 * jobs-*.ts file; jobs never overlap with themselves and errors are logged.
 * (For multi-instance deployments, move these to a single worker process.)
 */
const timers: NodeJS.Timeout[] = [];

export function registerJob(name: string, everyMs: number, fn: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[job:${name}]`, e);
    } finally {
      running = false;
    }
  };
  timers.push(setInterval(tick, everyMs));
}

export function stopJobs() {
  timers.forEach(clearInterval);
}
