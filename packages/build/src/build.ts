import { parse as parseYaml } from 'yaml';
import {
  CONFIG_FILE,
  HELP_CONTEXTS_FILE,
  RELEASE_SCHEMA_VERSION,
  displayText,
  firstChild,
  projectConfigSchema,
  sortDiagnostics,
  type CompiledRelease,
  type CompiledTopic,
  type Diagnostic,
  type NavEntry,
  type ProjectConfig,
  type Publication,
} from '@opend/model';
import { ditavalPolicy, filterNav, filterTree, type FilterPolicy } from '@opend/filter';
import {
  Workspace,
  findTopic,
  loadMap,
  parseDitaval,
  resolveTopic,
  topicPageId,
  type Keyspace,
  type MapModel,
} from '@opend/dita';
import { buildContexts } from './contexts.js';
import type { SourceTree } from './source.js';

export interface BuildResult {
  /** `null` when the project config is missing or invalid. */
  release: CompiledRelease | null;
  config: ProjectConfig | null;
  /** Policies applied at build time, for callers that filter more content later. */
  buildPolicies: FilterPolicy[];
  diagnostics: Diagnostic[];
  /** The parsed sources, for checks that need the original files. */
  workspace: Workspace;
  /** Topic files any map references, including ones the build-time filter excluded. */
  referencedTopicFiles: Set<string>;
}

export interface BuildOptions {
  now?: Date;
}

export function loadConfig(tree: SourceTree): {
  config: ProjectConfig | null;
  diagnostics: Diagnostic[];
} {
  const source = tree.texts.get(CONFIG_FILE);
  if (source === undefined) {
    return {
      config: null,
      diagnostics: [
        {
          severity: 'error',
          code: 'missing-config',
          message: `${CONFIG_FILE} not found`,
          file: CONFIG_FILE,
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return {
      config: null,
      diagnostics: [
        { severity: 'error', code: 'invalid-config', message: String(err), file: CONFIG_FILE },
      ],
    };
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: null,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: 'error' as const,
        code: 'invalid-config',
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        file: CONFIG_FILE,
      })),
    };
  }
  return { config: parsed.data, diagnostics: [] };
}

/**
 * Compiles a source tree into a release snapshot: loads the config and maps,
 * resolves every referenced topic, applies the build-time DITAVAL, and indexes
 * chunk usage. Problems are reported as diagnostics; the build still produces
 * as much of the release as it can so the previewer can show it.
 */
export function buildRelease(tree: SourceTree, options: BuildOptions = {}): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const workspace = new Workspace(tree.texts, tree.files);
  const { config, diagnostics: configDiagnostics } = loadConfig(tree);
  diagnostics.push(...configDiagnostics);
  if (!config) {
    return {
      release: null,
      config: null,
      buildPolicies: [],
      diagnostics,
      workspace,
      referencedTopicFiles: new Set(),
    };
  }

  const buildPolicies: FilterPolicy[] = [];
  if (config.buildFilter) {
    const source = tree.texts.get(config.buildFilter);
    if (source === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'missing-ditaval',
        message: `buildFilter not found: ${config.buildFilter}`,
        file: CONFIG_FILE,
      });
    } else {
      const { rules, diagnostics: d } = parseDitaval(source, config.buildFilter);
      diagnostics.push(...d);
      buildPolicies.push(ditavalPolicy(rules, 'build'));
    }
  }
  if (config.theme && !tree.files.has(config.theme)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-theme',
      message: `theme not found: ${config.theme}`,
      file: CONFIG_FILE,
    });
  }
  if (config.logo && !tree.files.has(config.logo)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-logo',
      message: `logo not found: ${config.logo}`,
      file: CONFIG_FILE,
    });
  }

  const site = loadMap(workspace, config.map);
  diagnostics.push(...site.diagnostics);
  const publicationMaps = config.publications.map((file) => {
    const model = loadMap(workspace, file);
    diagnostics.push(...model.diagnostics);
    return model;
  });

  const topics: Record<string, CompiledTopic> = {};
  const chunkUsage = new Map<string, Set<string>>();
  const assets = new Set<string>();

  // Each map resolves keys in its own keyspace. A topic shared by the site map
  // and a publication is compiled once, with the site map's keys.
  const compile = (
    file: string,
    keys: Keyspace,
    referencedFrom: { file: string; line?: number },
  ) => {
    const id = topicPageId(file);
    if (id in topics) return;
    const doc = workspace.document(file);
    if (!doc) return; // parse errors are already reported by the workspace
    const topic = findTopic(doc);
    if (!topic) {
      diagnostics.push({
        severity: 'error',
        code: 'not-a-topic',
        message: `${file} has no topic root element (referenced from ${referencedFrom.file})`,
        file,
        line: doc.loc?.line,
      });
      return;
    }
    if (!topic.attrs.id) {
      diagnostics.push({
        severity: 'error',
        code: 'missing-id',
        message: 'topic root element must have an id',
        file,
        line: topic.loc?.line,
        column: topic.loc?.column,
      });
    }
    const resolved = resolveTopic(topic, file, {
      ws: workspace,
      keys,
      diagnostics,
      onChunkUse: (chunk) => {
        const users = chunkUsage.get(chunk) ?? new Set<string>();
        users.add(id);
        chunkUsage.set(chunk, users);
      },
      onAsset: (path) => assets.add(path),
    });
    const body = filterTree(resolved, buildPolicies, { resolveChoices: false });
    if (!body) return; // excluded for every reader at build time
    const title = firstChild(body, 'title');
    topics[id] = {
      id,
      file,
      ditaId: topic.attrs.id ?? '',
      type: topic.name,
      title: title ? displayText(title) : id,
      body,
    };
  };

  for (const [file, from] of site.topicFiles) compile(file, site.keys, from);
  for (const pub of publicationMaps) {
    for (const [file, from] of pub.topicFiles) compile(file, pub.keys, from);
  }

  const nav = dropMissingTopics(filterNav(site.nav, buildPolicies), topics);
  const publications: Publication[] = publicationMaps.map((pub: MapModel) => ({
    file: pub.file,
    title: pub.title,
    nav: dropMissingTopics(filterNav(pub.nav, buildPolicies), topics),
  }));

  const release: CompiledRelease = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    release: config.release,
    title: config.title || site.title,
    builtAt: (options.now ?? new Date()).toISOString(),
    attributes: config.attributes,
    nav,
    publications,
    topics,
    chunkUsage: Object.fromEntries(
      [...chunkUsage].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
    ),
    assets: [...assets].sort(),
  };
  const contexts = buildContexts(
    // Keys for topics excluded at build time (e.g. audience="internal") are dropped.
    site.resourceIds.filter((r) => r.topicId in topics),
    [...site.topicFiles.keys()].map((f) => topics[topicPageId(f)]).filter((t) => t !== undefined),
    tree.texts.get(HELP_CONTEXTS_FILE),
    diagnostics,
  );
  if (Object.keys(contexts).length) release.contexts = contexts;
  if (tree.ref) release.sourceRef = tree.ref;
  if (config.theme) release.theme = config.theme;
  if (config.logo) release.logo = config.logo;
  if (config.pdf) release.pdf = config.pdf;

  diagnostics.push(...workspace.diagnostics);
  const referencedTopicFiles = new Set(
    [site, ...publicationMaps].flatMap((m) => [...m.topicFiles.keys()]),
  );
  return {
    release,
    config,
    buildPolicies,
    diagnostics: sortDiagnostics(dedupe(diagnostics)),
    workspace,
    referencedTopicFiles,
  };
}

/**
 * Removes links to topics that were not compiled (missing, unparseable or
 * excluded at build time). Nav titles stay empty when the map gives no
 * navtitle, so each reader's view can use the topic title as they see it.
 */
function dropMissingTopics(entries: NavEntry[], topics: Record<string, CompiledTopic>): NavEntry[] {
  return entries.map((e) => {
    const out: NavEntry = { ...e, children: dropMissingTopics(e.children, topics) };
    if (out.topicId && !(out.topicId in topics)) delete out.topicId;
    return out;
  });
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
