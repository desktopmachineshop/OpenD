import {
  CONFIG_FILE,
  RELEASE_ATTRIBUTE,
  TARGET_ATTR,
  isFilterAttribute,
  publicationSlug,
  sortDiagnostics,
  walk,
  type CompiledRelease,
  type Diagnostic,
  type ElementNode,
  type NavEntry,
  type ProjectConfig,
} from '@opend/model';
import { parseReleaseRange, tokens } from '@opend/filter';
import {
  SUPPORTED_ELEMENTS,
  TOPIC_TYPES,
  isMapFile,
  isTopicFile,
  type Workspace,
} from '@opend/dita';
import type { BuildResult } from '@opend/build';

/** Elements allowed in maps and bookmaps. */
// prettier-ignore
const MAP_ELEMENTS = new Set([
  'map', 'bookmap', 'title', 'topicmeta', 'navtitle', 'linktext', 'shortdesc', 'keywords', 'keyword',
  'searchtitle', 'data', 'topicref', 'topichead', 'topicgroup', 'keydef', 'mapref', 'ditavalref',
  'anchor', 'anchorref', 'navref', 'chapter', 'part', 'appendix', 'appendices', 'frontmatter',
  'backmatter', 'notices', 'booktitle', 'mainbooktitle', 'booktitlealt', 'bookmeta', 'booklists',
  'toc', 'indexlist', 'glossarylist', 'tablelist', 'figurelist', 'reltable', 'relheader',
  'relcolspec', 'relrow', 'relcell', 'glossref', 'resourceid',
]);

/**
 * Runs every check: the build's own diagnostics plus checks over all source
 * files (including ones no map references) and over the compiled release. The
 * CLI, CI and the previewer all call this, so they report the same problems.
 */
export function validate(result: BuildResult): Diagnostic[] {
  const out: Diagnostic[] = [...result.diagnostics];
  const { workspace, config, release } = result;
  if (config) {
    checkSources(workspace, config, out);
    if (release) checkRelease(result, release, out);
  }
  out.push(...workspace.diagnostics);
  return sortDiagnostics(dedupe(out));
}

function at(node: ElementNode): Pick<Diagnostic, 'file' | 'line' | 'column'> {
  return { file: node.loc?.file, line: node.loc?.line, column: node.loc?.column };
}

function checkSources(ws: Workspace, config: ProjectConfig, out: Diagnostic[]) {
  for (const file of ws.files().sort()) {
    const topicFile = isTopicFile(file);
    const mapFile = isMapFile(file);
    if (!topicFile && !mapFile) continue;
    const root = ws.document(file);
    if (!root) continue;
    if (topicFile && !TOPIC_TYPES.has(root.name) && root.name !== 'dita') continue; // other XML

    const vocabulary = mapFile ? MAP_ELEMENTS : SUPPORTED_ELEMENTS;
    walk(root, (el) => {
      checkFilterAttributes(el, config, out);
      if (!vocabulary.has(el.name)) {
        out.push({
          severity: 'warning',
          code: 'unsupported-element',
          message: `<${el.name}> is not in the supported DITA subset and will render as a plain block`,
          ...at(el),
        });
      }
      if (TOPIC_TYPES.has(el.name)) checkDuplicateIds(el, out);
    });
  }
}

function checkFilterAttributes(el: ElementNode, config: ProjectConfig, out: Diagnostic[]) {
  for (const [attribute, value] of Object.entries(el.attrs)) {
    if (!isFilterAttribute(attribute)) continue;
    for (const token of tokens(value)) {
      if (token === '-dita-use-conref-target') continue;
      if (attribute === RELEASE_ATTRIBUTE) {
        if (!parseReleaseRange(token)) {
          out.push({
            severity: 'error',
            code: 'invalid-release',
            message: `release="${token}" is not a version or range (use 1.4, 2.0.., ..1.9 or 1.2..1.9)`,
            ...at(el),
          });
        }
        continue;
      }
      const declared = config.attributes[attribute];
      if (!declared?.includes(token)) {
        out.push({
          severity: 'error',
          code: 'undeclared-value',
          message: declared
            ? `${attribute}="${token}" is not declared in opend.config.yaml (declared: ${declared.join(', ') || 'none'})`
            : `attribute "${attribute}" is not declared in opend.config.yaml`,
          ...at(el),
        });
      }
    }
  }
}

function checkDuplicateIds(topic: ElementNode, out: Diagnostic[]) {
  const seen = new Map<string, ElementNode>();
  const visit = (node: ElementNode) => {
    for (const child of node.children) {
      if (child.type !== 'element' || TOPIC_TYPES.has(child.name)) continue;
      const id = child.attrs.id;
      if (id) {
        const first = seen.get(id);
        if (first) {
          out.push({
            severity: 'error',
            code: 'duplicate-id',
            message: `id "${id}" is already used on line ${first.loc?.line ?? '?'} of this topic`,
            ...at(child),
          });
        } else seen.set(id, child);
      }
      visit(child);
    }
  };
  visit(topic);
}

function checkRelease(result: BuildResult, release: CompiledRelease, out: Diagnostic[]) {
  const inNav = new Set<string>();
  const collect = (entries: readonly NavEntry[]) => {
    for (const e of entries) {
      if (e.topicId) inNav.add(e.topicId);
      collect(e.children);
    }
  };
  collect(release.nav);

  for (const topic of Object.values(release.topics)) {
    walk(topic.body, (el) => {
      const target = el.attrs[TARGET_ATTR];
      if (target === undefined) return;
      const id = target.split('#')[0] ?? '';
      if (!inNav.has(id)) {
        out.push({
          severity: 'warning',
          code: 'link-to-unpublished',
          message: `link target ${id} is not in the site navigation, so readers see plain text`,
          ...at(el),
        });
      }
    });
  }

  // Publications are served at /pdf/<file name>.pdf, so file names must be unique.
  const slugs = new Map<string, string>();
  for (const publication of release.publications) {
    const slug = publicationSlug(publication.file);
    const first = slugs.get(slug);
    if (first === undefined) slugs.set(slug, publication.file);
    else
      out.push({
        severity: 'error',
        code: 'duplicate-publication',
        message: `publication ${publication.file} has the same file name as ${first}, so only one can be downloaded as ${slug}.pdf`,
        file: CONFIG_FILE,
      });
  }

  // Topic files that no map references and no published topic reuses are usually forgotten.
  const used = new Set(result.referencedTopicFiles);
  for (const chunk of Object.keys(release.chunkUsage)) used.add(chunk.split('#')[0] ?? '');
  for (const file of result.workspace.files()) {
    if (!isTopicFile(file) || used.has(file)) continue;
    const root = result.workspace.document(file);
    if (!root || (!TOPIC_TYPES.has(root.name) && root.name !== 'dita')) continue;
    out.push({
      severity: 'warning',
      code: 'unreferenced-topic',
      message: 'topic is not in any map and no published topic reuses it',
      file,
    });
  }
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
