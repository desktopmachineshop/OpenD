import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDiagnostic, hasErrors } from '@opend/model';
import { buildRelease, readDirectory, type SourceTree } from '@opend/build';
import { validate } from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

function tree(files: Record<string, string>): SourceTree {
  return { files: new Set(Object.keys(files)), texts: new Map(Object.entries(files)) };
}

describe('validate', () => {
  it('passes the starter template cleanly', async () => {
    const diagnostics = validate(buildRelease(await readDirectory(STARTER)));
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('reports content problems with locations', () => {
    const diagnostics = validate(
      buildRelease(
        tree({
          'opend.config.yaml':
            'release: "2.0"\nmap: main.ditamap\nattributes:\n  product: [widget]\n',
          'main.ditamap': '<map>\n<topicref href="a.dita" product="widgit"/>\n</map>',
          'a.dita': [
            '<topic id="a"><title>A</title><body>',
            '<p release="next">bad range</p>',
            '<p platform="linux">undeclared attribute</p>',
            '<p id="x"/><p id="x"/>',
            '<blink>unknown</blink>',
            '<p><xref href="b.dita"/></p>',
            '</body></topic>',
          ].join('\n'),
          'b.dita': '<topic id="b"><title>B</title></topic>',
          'broken.dita': '<topic id="broken"><title>oops</topic>',
        }),
      ),
    );
    expect(diagnostics.map(formatDiagnostic)).toEqual([
      'a.dita:2:1: error [invalid-release] release="next" is not a version or range (use 1.4, 2.0.., ..1.9 or 1.2..1.9)',
      'a.dita:3:1: error [undeclared-value] attribute "platform" is not declared in opend.config.yaml',
      'a.dita:4:12: error [duplicate-id] id "x" is already used on line 4 of this topic',
      'a.dita:5:1: warning [unsupported-element] <blink> is not in the supported DITA subset and will render as a plain block',
      'a.dita:6:4: warning [link-to-unpublished] link target b is not in the site navigation, so readers see plain text',
      'b.dita: warning [unreferenced-topic] topic is not in any map and no published topic reuses it',
      expect.stringMatching(/^broken\.dita:1:\d+: error \[xml-syntax\]/),
      'main.ditamap:2:1: error [undeclared-value] product="widgit" is not declared in opend.config.yaml (declared: widget)',
    ]);
    expect(hasErrors(diagnostics)).toBe(true);
  });

  it('accepts topics only a publication uses, and rejects publications sharing a file name', () => {
    const files = {
      'opend.config.yaml':
        'release: "2.0"\nmap: m.ditamap\npublications: [a/guide.bookmap, b/guide.bookmap]\n',
      'm.ditamap': '<map><topicref href="site.dita"/></map>',
      'a/guide.bookmap': '<bookmap><chapter href="../book.dita"/></bookmap>',
      'b/guide.bookmap': '<bookmap><chapter href="../site.dita"/></bookmap>',
      'site.dita': '<topic id="site"><title>Site</title></topic>',
      'book.dita': '<topic id="book"><title>Book only</title></topic>',
    };
    const result = buildRelease(tree(files));
    expect(result.release?.topics['book']?.title).toBe('Book only');
    expect(validate(result).map(formatDiagnostic)).toEqual([
      'opend.config.yaml: error [duplicate-publication] publication b/guide.bookmap has the same file name as a/guide.bookmap, so only one can be downloaded as guide.pdf',
    ]);
  });

  it('does not flag topics excluded at build time as unreferenced', () => {
    const diagnostics = validate(
      buildRelease(
        tree({
          'opend.config.yaml':
            'release: "1"\nmap: m.ditamap\nbuildFilter: f.ditaval\nattributes:\n  audience: [internal]\n',
          'f.ditaval': '<val><prop att="audience" val="internal" action="exclude"/></val>',
          'm.ditamap':
            '<map><topicref href="a.dita"/><topicref href="i.dita" audience="internal"/></map>',
          'a.dita': '<topic id="a"><title>A</title></topic>',
          'i.dita': '<topic id="i" audience="internal"><title>I</title></topic>',
        }),
      ),
    );
    expect(diagnostics).toEqual([]);
  });
});
