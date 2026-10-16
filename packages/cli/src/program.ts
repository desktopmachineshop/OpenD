import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { formatDiagnostic, hasErrors, type Diagnostic } from '@opend/model';
import { audienceFromOptions, collectList, describeAudience, loadProject } from './project.js';
import { startPreview } from './server.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function formatGithub(d: Diagnostic): string {
  const level = d.severity === 'error' ? 'error' : 'warning';
  const props = [
    d.file && `file=${d.file}`,
    d.line && `line=${d.line}`,
    d.column && `col=${d.column}`,
    `title=${d.code}`,
  ]
    .filter(Boolean)
    .join(',');
  return `::${level} ${props}::${d.message.replace(/\r?\n/g, ' ')}`;
}

function report(io: Io, diagnostics: Diagnostic[], format: string) {
  for (const d of diagnostics) {
    if (format === 'github') io.out(formatGithub(d));
    else (d.severity === 'error' ? io.err : io.out)(formatDiagnostic(d));
  }
  if (format === 'json') return;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  io.out(`${errors} error(s), ${diagnostics.length - errors} warning(s)`);
}

function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new InvalidArgumentError('not a port number');
  return port;
}

/** Builds the `opend` command. Returns the exit code through `setExitCode`. */
export function createProgram(
  io: Io = defaultIo,
  setExitCode = (code: number) => (process.exitCode = code),
): Command {
  const program = new Command('opend')
    .description('Build, validate and preview DITA docs where release and entitlement are one rule')
    .version('0.1.0')
    // Program options only before the subcommand, so `preview --version 1.4` reaches preview.
    .enablePositionalOptions()
    .configureOutput({
      writeOut: (s) => io.out(s.trimEnd()),
      writeErr: (s) => io.err(s.trimEnd()),
    });

  program
    .command('validate')
    .description(
      'run the same checks as CI: broken links, missing chunks, undeclared values, and more',
    )
    .argument('[dir]', 'docs root containing opend.config.yaml', '.')
    .option('--ref <ref>', 'validate a git branch or tag instead of the working tree')
    .option('--strict', 'treat warnings as failures')
    .option('--format <format>', 'text, json or github (workflow annotations)', 'text')
    .action(async (dir: string, opts: { ref?: string; strict?: boolean; format: string }) => {
      const project = await loadProject(dir, opts.ref);
      const diagnostics = [...project.diagnostics, ...project.contextDiagnostics];
      if (opts.format === 'json') io.out(JSON.stringify(diagnostics, null, 2));
      else report(io, diagnostics, opts.format);
      const failed = hasErrors(diagnostics) || (opts.strict === true && diagnostics.length > 0);
      setExitCode(failed ? 1 : 0);
    });

  program
    .command('build')
    .description(
      'compile the docs into a release snapshot (JSON), as the hosted build would store it',
    )
    .argument('[dir]', 'docs root containing opend.config.yaml', '.')
    .option('--ref <ref>', 'build a git branch or tag instead of the working tree')
    .option('--out <file>', 'output file (default: .opend/build/<release>.json in the docs root)')
    .action(async (dir: string, opts: { ref?: string; out?: string }) => {
      const project = await loadProject(dir, opts.ref);
      report(io, project.diagnostics, 'text');
      const release = project.build.release;
      if (!release || hasErrors(project.diagnostics)) {
        setExitCode(1);
        return;
      }
      const out = opts.out ?? join(project.root, '.opend', 'build', `${release.release}.json`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(release, null, 2)}\n`);
      io.out(`wrote ${displayPath(out)} (${Object.keys(release.topics).length} topics)`);
      setExitCode(0);
    });

  program
    .command('preview')
    .description('serve the docs on localhost and rebuild on save; nothing leaves the machine')
    .argument('[dir]', 'docs root containing opend.config.yaml', '.')
    .option('--as <name>', 'preview as a named reader from preview-contexts.yaml')
    .option(
      '--product <list>',
      'preview as a reader holding these products (comma-separated)',
      collectList,
    )
    .option(
      '--feature <list>',
      'preview as a reader holding these features (comma-separated)',
      collectList,
    )
    .option('--version <version>', "reader's release, e.g. 1.4 (default: the project's release)")
    .option('--all', 'show everything with conditions marked (the default)')
    .option('--ref <ref>', 'preview a git branch or tag instead of the working tree (no watching)')
    .option('-p, --port <port>', 'port to listen on', parsePort, 4000)
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--no-watch', 'do not rebuild on file changes')
    .action(
      async (
        dir: string,
        opts: {
          as?: string;
          product?: string[];
          feature?: string[];
          version?: string;
          all?: boolean;
          ref?: string;
          port: number;
          host: string;
          watch: boolean;
        },
      ) => {
        const preview = await startPreview({
          dir,
          ref: opts.ref,
          audience: (project) =>
            audienceFromOptions(opts, project.contexts, project.build.config?.release ?? '0'),
          port: opts.port,
          host: opts.host,
          watch: opts.watch,
          onRebuild: (project, ms) => {
            const all = [...project.diagnostics, ...project.contextDiagnostics];
            io.out(`rebuilt in ${ms} ms`);
            report(io, all, 'text');
          },
        });
        const all = [...preview.project().diagnostics, ...preview.project().contextDiagnostics];
        report(io, all, 'text');
        io.out(`Previewing as ${describeAudience(preview.audience)}`);
        io.out(
          `Serving ${preview.url}${opts.ref ? ` (git ref ${opts.ref})` : opts.watch ? ' (watching for changes)' : ''}`,
        );
      },
    );

  return program;
}
