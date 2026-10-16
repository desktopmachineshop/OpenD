import { z } from 'zod';

/**
 * What one reader is entitled to see. The entitlement service produces this
 * from the reader's login; the previewer reads it from a local file.
 */
export const readerContextSchema = z.object({
  org: z.string().optional(),
  products: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
  /** The release the reader runs, e.g. `1.4`. */
  version: z.string().min(1),
});

export type ReaderContext = z.infer<typeof readerContextSchema>;

export const previewContextsSchema = z.object({
  contexts: z.record(z.string(), readerContextSchema),
});

export type PreviewContexts = z.infer<typeof previewContextsSchema>;

export const PREVIEW_CONTEXTS_FILE = 'preview-contexts.yaml';

/**
 * Canonical key for the entitlement set of a context. Two readers with the same
 * key see exactly the same content, so renders are cached by this key rather
 * than by user or org.
 */
export function entitlementKey(ctx: ReaderContext): string {
  const list = (xs: string[]) => [...new Set(xs)].sort().join(',');
  return `p=${list(ctx.products)};f=${list(ctx.features)};v=${ctx.version}`;
}
