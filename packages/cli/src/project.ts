import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  PREVIEW_CONTEXTS_FILE,
  previewContextsSchema,
  readerContextSchema,
  type Diagnostic,
  type PreviewContexts,
  type ReaderContext,
} from '@opend/model';
import {
  buildRelease,
  readDirectory,
  readGitRef,
  type BuildResult,
  type SourceTree,
} from '@opend/build';
import { validate } from '@opend/validate';
import { readerPolicy, type FilterPolicy } from '@opend/filter';

export interface LoadedProject {
  root: string;
  ref?: string;
  tree: SourceTree;
  build: BuildResult;
  /** Build plus validation diagnostics. */
  diagnostics: Diagnostic[];
  contexts: PreviewContexts['contexts'];
  contextDiagnostics: Diagnostic[];
}

/** Reads, builds and validates a docs project. */
export async function loadProject(dir: string, ref?: string): Promise<LoadedProject> {
  const root = resolve(dir);
  const tree = ref ? await readGitRef(root, ref) : await readDirectory(root);
  const build = buildRelease(tree);
  const { contexts, diagnostics: contextDiagnostics } = loadPreviewContexts(tree);
  const project: LoadedProject = {
    root,
    tree,
    build,
    diagnostics: validate(build),
    contexts,
    contextDiagnostics,
  };
  if (ref) project.ref = ref;
  return project;
}

export function loadPreviewContexts(tree: SourceTree): {
  contexts: PreviewContexts['contexts'];
  diagnostics: Diagnostic[];
} {
  const source = tree.texts.get(PREVIEW_CONTEXTS_FILE);
  if (source === undefined) return { contexts: {}, diagnostics: [] };
  try {
    const parsed = previewContextsSchema.safeParse(parseYaml(source));
    if (parsed.success) return { contexts: parsed.data.contexts, diagnostics: [] };
    return {
      contexts: {},
      diagnostics: parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        code: 'invalid-preview-contexts',
        message: `${i.path.join('.')}: ${i.message}`,
        file: PREVIEW_CONTEXTS_FILE,
      })),
    };
  } catch (err) {
    return {
      contexts: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'invalid-preview-contexts',
          message: String(err),
          file: PREVIEW_CONTEXTS_FILE,
        },
      ],
    };
  }
}

/** Who the preview renders for. */
export type PreviewAudience =
  | { kind: 'all' }
  | { kind: 'named'; name: string; context: ReaderContext }
  | { kind: 'inline'; context: ReaderContext };

export interface AudienceOptions {
  as?: string;
  all?: boolean;
  product?: string[];
  feature?: string[];
  version?: string;
}

/**
 * Picks the audience from CLI options. With no options the preview shows
 * everything (the staff view), with conditions marked.
 */
export function audienceFromOptions(
  options: AudienceOptions,
  contexts: PreviewContexts['contexts'],
  defaultVersion: string,
): PreviewAudience {
  if (options.all) return { kind: 'all' };
  if (options.as) {
    const context = contexts[options.as];
    if (!context) {
      const known = Object.keys(contexts);
      throw new Error(
        `unknown preview context "${options.as}"` +
          (known.length ? ` (known: ${known.join(', ')})` : ` (no ${PREVIEW_CONTEXTS_FILE} found)`),
      );
    }
    return { kind: 'named', name: options.as, context };
  }
  if (options.product || options.feature || options.version) {
    return {
      kind: 'inline',
      context: readerContextSchema.parse({
        products: options.product ?? [],
        features: options.feature ?? [],
        version: options.version ?? defaultVersion,
      }),
    };
  }
  return { kind: 'all' };
}

export function policiesFor(audience: PreviewAudience): FilterPolicy[] {
  return audience.kind === 'all' ? [] : [readerPolicy(audience.context)];
}

export function describeAudience(audience: PreviewAudience): string {
  if (audience.kind === 'all') return 'everything (staff view, conditions marked)';
  const c = audience.context;
  const parts = [
    c.org ? `org ${c.org}` : '',
    `products ${c.products.join(', ') || 'none'}`,
    `features ${c.features.join(', ') || 'none'}`,
    `version ${c.version}`,
  ].filter(Boolean);
  return `${audience.kind === 'named' ? `${audience.name}: ` : ''}${parts.join(' · ')}`;
}

/** Comma- or repeat-separated list option parser for commander. */
export function collectList(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}
