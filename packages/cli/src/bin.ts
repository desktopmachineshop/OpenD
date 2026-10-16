#!/usr/bin/env node
import { createProgram } from './program.js';

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`opend: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
