import { purgeAnalytics, type Pool } from '@opend/store';
import type { Log } from '@opend/worker';

/** Purges once now, then every `intervalMs` (default six hours) until stopped. */
export function startAnalyticsPurge(options: {
  pool: Pool;
  retentionDays: number;
  log: Log;
  intervalMs?: number;
}): { stop(): Promise<void>; ran: Promise<void> } {
  const interval = options.intervalMs ?? 6 * 3600_000;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  const run = async () => {
    try {
      const purged = await purgeAnalytics(options.pool, options.retentionDays);
      if (purged.events || purged.feedback)
        options.log({ level: 'info', msg: 'analytics purged', ...purged });
    } catch (err) {
      options.log({ level: 'warn', msg: 'analytics purge failed', error: String(err) });
    }
    if (!stopped) {
      timer = setTimeout(() => {
        current = run();
      }, interval);
      timer.unref();
    }
  };
  current = run();
  return {
    ran: current,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
