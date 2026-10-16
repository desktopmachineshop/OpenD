import type { Diagnostic, ElementNode } from '@opend/model';
import { parseXml } from './xml.js';

/**
 * The source files of one build, read up front so that DITA processing is
 * synchronous. Documents are parsed lazily and once.
 */
export class Workspace {
  readonly diagnostics: Diagnostic[] = [];
  private readonly parsed = new Map<string, ElementNode | null>();

  /**
   * @param texts contents of the XML files (topics, maps, DITAVAL), by docs-root-relative path
   * @param allFiles every file in the source tree, including images, for existence checks
   */
  constructor(
    private readonly texts: ReadonlyMap<string, string>,
    private readonly allFiles: ReadonlySet<string>,
  ) {}

  has(file: string): boolean {
    return this.allFiles.has(file) || this.texts.has(file);
  }

  files(): string[] {
    return [...this.texts.keys()];
  }

  /** The parsed root element, or `null` if the file is missing or not well-formed. */
  document(file: string): ElementNode | null {
    if (this.parsed.has(file)) return this.parsed.get(file) ?? null;
    const source = this.texts.get(file);
    let root: ElementNode | null = null;
    if (source !== undefined) {
      const result = parseXml(source, file);
      this.diagnostics.push(...result.diagnostics);
      root = result.root;
    }
    this.parsed.set(file, root);
    return root;
  }
}
