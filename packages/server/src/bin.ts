#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { editorCommand } from '@opend/editor';
import {
  SecretBox,
  SettingsCache,
  createBlobStore,
  createPool,
  deriveSecretKey,
  migrate,
  purgeAnalytics,
  storedGitHubApp,
} from '@opend/store';
import { GitHubConnection, jsonLog, startPoller, startWorker } from '@opend/worker';
import { mintSetupLink } from './admin.js';
import { startAnalyticsPurge } from './analytics-purge.js';
import { autoConnect } from './auto-connect.js';
import { createApp } from './app.js';
import { loadFleetConfig } from './fleet/config.js';
import { migrateFleet, startFleet } from './fleet/serve.js';
import { startFleetWorker } from './fleet/worker.js';
import { DEFAULT_ANALYTICS, loadConfig } from './config.js';
import { runReconcileCommand, type ReconcileCommandOptions } from './reconcile-command.js';
import { runReindexCommand, type ReindexCommandOptions } from './reindex-command.js';
import { applySeed } from './seed.js';

const program = new Command('opend-server').description(
  'Hosted OpenD: delivery, webhook, worker and admin',
);

program
  .command('migrate')
  .description('apply database migrations')
  .action(async () => {
    const config = loadConfig();
    const pool = createPool(config.databaseUrl);
    const ran = await migrate(pool);
    jsonLog({ level: 'info', msg: 'migrations applied', ran });
    await pool.end();
  });

program
  .command('serve')
  .description('serve readers, the GitHub webhook and the admin API')
  .action(async () => {
    const config = loadConfig();
    const pool = createPool(config.databaseUrl);
    const { app, ctx } = await createApp(config, { pool, blobs: createBlobStore(config.blobs) });
    await app.listen({ port: config.port, host: config.host });
    jsonLog({
      level: 'info',
      msg: 'serving',
      url: config.publicUrl,
      oidc: Boolean(ctx.config.oidc),
      devLogin: ctx.config.devLogin,
      webhook: Boolean(ctx.config.webhookSecret),
      github: ctx.github.mode(),
      admin: Boolean(config.adminToken),
      blobs: config.blobs.kind,
    });
    const shutdown = async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  });

program
  .command('worker')
  .description('run build jobs')
  .action(async () => {
    const config = loadConfig();
    const pool = createPool(config.databaseUrl);
    // The GitHub App from the environment, the broker, or the one Connect GitHub stored.
    const key = deriveSecretKey({
      secretKey: config.secretKey,
      sessionSecret: config.sessionSecret,
    });
    const settings = new SettingsCache(pool, key ? new SecretBox(key) : null);
    await settings
      .reload()
      .catch((err: unknown) =>
        jsonLog({ level: 'warn', msg: 'settings not loaded', error: String(err) }),
      );
    const settingsListener = settings.listen(config.databaseUrl, (err) =>
      jsonLog({ level: 'warn', msg: 'settings reload failed', error: String(err) }),
    );
    const github = new GitHubConnection({
      app: config.github ?? null,
      broker: config.broker ?? null,
      stored: () => {
        const app = storedGitHubApp(settings.current);
        return app ? { appId: app.appId, privateKey: app.privateKey, apiUrl: app.apiUrl } : null;
      },
      ...(config.githubApiUrl ? { apiUrl: config.githubApiUrl } : {}),
      ...(config.githubWebUrl ? { webUrl: config.githubWebUrl } : {}),
      log: jsonLog,
    });
    const worker = startWorker({
      pool,
      blobs: createBlobStore(config.blobs),
      github,
      databaseUrl: config.databaseUrl,
    });
    // Polling mode, for installs that GitHub's webhooks cannot reach.
    const pollSeconds = config.selfHosting?.pollIntervalSeconds ?? 0;
    // Each tick also connects the docs source when GitHub exposes exactly one repository.
    const poller =
      pollSeconds > 0
        ? startPoller({
            pool,
            github,
            intervalMs: pollSeconds * 1000,
            beforePoll: () =>
              autoConnect({ pool, github, settings, log: jsonLog, config, env: config }),
          })
        : null;
    // Retention applies even with analytics off, so old rows still go.
    const retentionDays = (config.analytics ?? DEFAULT_ANALYTICS).retentionDays;
    const purge = startAnalyticsPurge({ pool, retentionDays, log: jsonLog });
    jsonLog({
      level: 'info',
      msg: 'worker started',
      github: github.mode(),
      blobs: config.blobs.kind,
      pollSeconds,
      analyticsRetentionDays: retentionDays,
    });
    const shutdown = async () => {
      await poller?.stop();
      await purge.stop();
      await worker.stop();
      await settingsListener.stop();
      await pool.end();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  });

const fleetCommand = program
  .command('fleet')
  .description('many sites from one deployment, each in its own schema (managed hosting)');

fleetCommand
  .command('migrate')
  .description('migrate the fleet registry and every site schema (run before each deploy)')
  .action(async () => {
    const results = await migrateFleet(loadFleetConfig());
    jsonLog({ level: 'info', msg: 'fleet migrated', sites: results.length });
  });

fleetCommand
  .command('serve')
  .description('serve every site of the fleet by host name, and the fleet admin API')
  .action(async () => {
    const config = loadFleetConfig();
    const fleet = await startFleet(config);
    await new Promise<void>((resolve) =>
      fleet.server.listen(config.port, config.bindHost, resolve),
    );
    jsonLog({ level: 'info', msg: 'fleet serving', host: config.host, maxSites: config.maxSites });
    const shutdown = async () => {
      await fleet.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  });

fleetCommand
  .command('worker')
  .description('run build jobs for every site of the fleet')
  .action(async () => {
    const config = loadFleetConfig();
    const worker = await startFleetWorker(config);
    jsonLog({ level: 'info', msg: 'fleet worker started', concurrency: config.workerConcurrency });
    const shutdown = async () => {
      await worker.stop();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  });

program
  .command('admin-link')
  .description('print a one-time link that makes its visitor the first staff reader')
  .option('--minutes <n>', 'minutes the link stays valid', '30')
  .option('--force', 'mint one even though a staff reader exists')
  .action(async (options: { minutes: string; force?: boolean }) => {
    const config = loadConfig();
    const minutes = Number(options.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
      throw new Error('--minutes must be a whole number from 5 to 1440');
    const pool = createPool(config.databaseUrl);
    try {
      const link = await mintSetupLink(pool, config.publicUrl, {
        minutes,
        actor: 'cli',
        force: options.force === true,
      });
      if (!link)
        throw new Error(
          'a staff reader already exists: sign in as staff and open /admin (or pass --force)',
        );
      process.stdout.write(
        `Open this link within ${minutes} minutes to become the first staff reader (it works once):\n${link.url}\n`,
      );
    } finally {
      await pool.end();
    }
  });

program
  .command('purge-analytics')
  .description('delete analytics older than OPEND_ANALYTICS_RETENTION_DAYS')
  .option('--days <n>', 'retention in days (default: OPEND_ANALYTICS_RETENTION_DAYS)')
  .action(async (options: { days?: string }) => {
    const config = loadConfig();
    const days = options.days
      ? Number(options.days)
      : (config.analytics ?? DEFAULT_ANALYTICS).retentionDays;
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number >= 1');
    const pool = createPool(config.databaseUrl);
    const purged = await purgeAnalytics(pool, days);
    jsonLog({ level: 'info', msg: 'analytics purged', days, ...purged });
    await pool.end();
  });

program
  .command('seed')
  .description('load repos, orgs, entitlements and readers from a YAML file')
  .argument('<file>')
  .action(async (file: string) => {
    const config = loadConfig();
    const pool = createPool(config.databaseUrl);
    const counts = await applySeed(pool, await readFile(file, 'utf8'));
    jsonLog({ level: 'info', msg: 'seed applied', ...counts });
    await pool.end();
  });

program
  .command('reconcile')
  .description('apply a customer and licence snapshot from a CRM or billing export')
  .option('--from <url>', 'export URL (default: ENTITLEMENT_SOURCE_URL)')
  .option('--mode <mode>', 'merge or replace (default: ENTITLEMENT_SYNC_MODE, else merge)')
  .option('--dry-run', 'print the changes without applying them')
  .option('--allow-empty', 'apply a replace even when the export lists no orgs')
  .action(async (options: ReconcileCommandOptions) => {
    await runReconcileCommand(loadConfig(), options);
  });

program
  .command('reindex')
  .description('rebuild the search index of every stored release, or of one')
  .option('--release <id>', 'only this release id')
  .action(async (options: ReindexCommandOptions) => {
    await runReindexCommand(loadConfig(), options);
  });

// The web editor runs as its own service on its own host; see ADR 0007.
program.addCommand(editorCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opend-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
