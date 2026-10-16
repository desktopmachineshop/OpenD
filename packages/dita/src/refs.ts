import { posix } from 'node:path';

/** A parsed DITA address such as `../reuse/common.dita#common/power-warning`. */
export interface DitaRef {
  /** Docs-root-relative file path; the current file for same-file references. */
  file: string;
  topicId?: string;
  elementId?: string;
}

export function isExternalHref(href: string, scope?: string): boolean {
  return scope === 'external' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** Resolves a docs-root-relative path against the file it appears in. `null` if it escapes the root. */
export function resolvePath(fromFile: string, relative: string): string | null {
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), decodeURI(relative)));
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null;
  return joined;
}

/** Parses an `href` or `conref` value. Returns `null` for paths outside the docs root. */
export function parseRef(value: string, fromFile: string): DitaRef | null {
  const hash = value.indexOf('#');
  const pathPart = hash === -1 ? value : value.slice(0, hash);
  const fragment = hash === -1 ? '' : value.slice(hash + 1);
  const file = pathPart === '' ? fromFile : resolvePath(fromFile, pathPart);
  if (file === null) return null;
  const ref: DitaRef = { file };
  if (fragment) {
    const [topicId, elementId] = fragment.split('/', 2);
    if (topicId) ref.topicId = topicId;
    if (elementId) ref.elementId = elementId;
  }
  return ref;
}

export function formatRef(ref: DitaRef): string {
  if (!ref.topicId) return ref.file;
  return `${ref.file}#${ref.topicId}${ref.elementId ? `/${ref.elementId}` : ''}`;
}

const DITA_EXTENSIONS = ['.dita', '.xml'];
const MAP_EXTENSIONS = ['.ditamap', '.bookmap'];

export function isTopicFile(file: string): boolean {
  return DITA_EXTENSIONS.includes(posix.extname(file).toLowerCase());
}

export function isMapFile(file: string): boolean {
  return MAP_EXTENSIONS.includes(posix.extname(file).toLowerCase());
}

/** Page id for a topic file: the path without its extension. */
export function topicPageId(file: string): string {
  const ext = posix.extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}
