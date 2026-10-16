#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { createBlobStore, createPool, migrate } from '@opend/store';
import { GitHubApp, jsonLog, startPoller, startWorker } from '@opend/worker';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { runReconcileCommand, type ReconcileCommandOptions } from './reconcile-command.js';
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
    const { app } = await createApp(config, { pool, blobs: createBlobStore(config.blobs) });
    await app.listen({ port: config.port, host: config.host });
    jsonLog({
      level: 'info',
      msg: 'serving',
      url: config.publicUrl,
      oidc: Boolean(config.oidc),
      devLogin: config.devLogin,
      webhook: Boolean(config.webhookSecret),
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
    const github = config.github ? new GitHubApp(config.github) : null;
    const worker = startWorker({
      pool,
      blobs: createBlobStore(config.blobs),
      github,
      databaseUrl: config.databaseUrl,
    });
    // Polling mode, for installs that GitHub's webhooks cannot reach.
    const pollSeconds = config.selfHosting?.pollIntervalSeconds ?? 0;
    const poller =
      pollSeconds > 0 ? startPoller({ pool, github, intervalMs: pollSeconds * 1000 }) : null;
    jsonLog({
      level: 'info',
      msg: 'worker started',
      github: Boolean(github),
      blobs: config.blobs.kind,
      pollSeconds,
    });
    const shutdown = async () => {
      await poller?.stop();
      await worker.stop();
      await pool.end();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opend-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
