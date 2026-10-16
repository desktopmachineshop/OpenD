#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { FsBlobStore, createPool, migrate } from '@opend/store';
import { GitHubApp, jsonLog, startWorker } from '@opend/worker';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
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
    const { app } = await createApp(config, { pool, blobs: new FsBlobStore(config.blobDir) });
    await app.listen({ port: config.port, host: config.host });
    jsonLog({
      level: 'info',
      msg: 'serving',
      url: config.publicUrl,
      oidc: Boolean(config.oidc),
      devLogin: config.devLogin,
      webhook: Boolean(config.webhookSecret),
      admin: Boolean(config.adminToken),
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
      blobs: new FsBlobStore(config.blobDir),
      github,
      databaseUrl: config.databaseUrl,
    });
    jsonLog({ level: 'info', msg: 'worker started', github: Boolean(github) });
    const shutdown = async () => {
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`opend-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
