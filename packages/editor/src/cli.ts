import { Command } from 'commander';
import { createPool, listEditorUsers, setEditorUserDisabled, upsertEditorUser } from '@opend/store';
import { jsonLog } from '@opend/worker';
import { createEditorApp } from './app.js';
import { loadEditorConfig } from './config.js';

/** DATABASE_URL alone, for the user commands that need no other settings. */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  return url;
}

/**
 * The editor's commands. Mounted as `opend-server editor ...` in the hosted
 * image and as the standalone `opend-editor` binary.
 */
export function editorCommand(name = 'editor'): Command {
  const command = new Command(name).description('the web editor for authors');

  command
    .command('serve', { isDefault: true })
    .description('serve the web editor on its own host (EDITOR_PUBLIC_URL)')
    .action(async () => {
      const config = loadEditorConfig();
      const pool = createPool(config.databaseUrl);
      const { app } = await createEditorApp(config, { pool });
      await app.listen({ port: config.port, host: config.host });
      jsonLog({
        level: 'info',
        msg: 'editor serving',
        url: config.publicUrl,
        repo: config.repo ?? '(the registered repo)',
        base: config.baseBranch,
        github: Boolean(config.githubOAuth),
        oidc: Boolean(config.oidc),
      });
      const shutdown = async () => {
        await app.close();
        await pool.end();
        process.exit(0);
      };
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    });

  command
    .command('add-user')
    .description('register an editor; they sign in with company OIDC (verified email) or GitHub')
    .argument('<email>')
    .option('--name <name>', 'display name, used as the commit author')
    .option('--github <login>', 'GitHub login, for developers who sign in with GitHub')
    .action(async (email: string, options: { name?: string; github?: string }) => {
      const pool = createPool(databaseUrl());
      try {
        const user = await upsertEditorUser(pool, {
          email,
          name: options.name ?? null,
          githubLogin: options.github ?? null,
        });
        jsonLog({ level: 'info', msg: 'editor registered', id: user.id, email: user.email });
      } finally {
        await pool.end();
      }
    });

  command
    .command('disable-user')
    .description('stop an editor signing in and end their sessions')
    .argument('<email>')
    .action(async (email: string) => {
      const pool = createPool(databaseUrl());
      try {
        const found = await setEditorUserDisabled(pool, email, true);
        if (!found) throw new Error(`no editor ${email}`);
        jsonLog({ level: 'info', msg: 'editor disabled', email });
      } finally {
        await pool.end();
      }
    });

  command
    .command('list-users')
    .description('list editors')
    .action(async () => {
      const pool = createPool(databaseUrl());
      try {
        for (const u of await listEditorUsers(pool)) {
          process.stdout.write(
            `${u.id}\t${u.email}\t${u.name}\t${u.githubLogin ?? ''}${u.disabled ? '\tdisabled' : ''}\n`,
          );
        }
      } finally {
        await pool.end();
      }
    });

  return command;
}
