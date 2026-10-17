import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let cached: Promise<string> | null = null;

/**
 * The visual editor's browser script (`/assets/visual.js`): `visual/entry` and
 * ProseMirror bundled into one file, once per process. It runs from the
 * TypeScript sources in development and tests, and from the compiled output
 * in the image, so no separate build step is needed.
 */
export function visualScript(): Promise<string> {
  cached ??= (async () => {
    const ts = fileURLToPath(new URL('./visual/entry.ts', import.meta.url));
    const entry = existsSync(ts)
      ? ts
      : fileURLToPath(new URL('./visual/entry.js', import.meta.url));
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    return result.outputFiles[0]!.text;
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
