#!/usr/bin/env node
import { editorCommand } from './cli.js';

editorCommand('opend-editor')
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`opend-editor: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
