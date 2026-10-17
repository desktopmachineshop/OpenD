import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { FILTER_ATTRIBUTES } from '@opend/model';
import { CONDITION_ATTRS } from '../src/visual/schema.js';
import { canonical, VisualTopic, type XmlParser } from '../src/visual/topic.js';

const parser: XmlParser = (xml) =>
  new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml') as unknown as Document;

const ROOT = join(import.meta.dirname, '../../..');

function ditaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...ditaFiles(p));
    else if (name.endsWith('.dita')) out.push(p);
  }
  return out;
}

const load = (src: string) => {
  const r = VisualTopic.load(src, parser);
  if (!r.ok) throw new Error(r.reason);
  return r.topic;
};

/** Replaces the text "from" in the first text node that has it, as an author's edit would. */
function edit(topic: VisualTopic, from: string, to: string): string {
  const state = EditorState.create({ doc: topic.doc });
  let tr = state.tr;
  topic.doc.descendants((node, pos) => {
    if (tr.docChanged || !node.isText) return;
    const at = node.text!.indexOf(from);
    if (at !== -1) tr = tr.insertText(to, pos + at, pos + at + from.length);
  });
  if (!tr.docChanged) throw new Error(`no text "${from}"`);
  return topic.toSource(tr.doc);
}

describe('visual editor: DITA round trip', () => {
  const files = [...ditaFiles(join(ROOT, 'site')), ...ditaFiles(join(ROOT, 'templates'))];

  it.each(files.map((f) => [relative(ROOT, f), f]))('opens %s visually', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const r = VisualTopic.load(src, parser);
    if (!r.ok && /Maps|<(dita|glossentry|bookmap)>/.test(r.reason)) return;
    expect(r.ok ? 'ok' : r.reason).toBe('ok');
  });

  it('writes back only the block that changed', () => {
    const src = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">
<concept id="c">
  <title>Title</title>
  <shortdesc>Short.</shortdesc>
  <conbody>
    <p>First   paragraph,
       oddly wrapped.</p>
    <!-- keep me -->
    <p>Second <b>bold</b> paragraph.</p>
    <table><tgroup cols="1"><tbody><row><entry>cell</entry></row></tbody></tgroup></table>
  </conbody>
</concept>
`;
    const topic = load(src);
    expect(topic.toSource(topic.doc)).toBe(src);
    const out = edit(topic, 'Second', 'Changed');
    expect(out).toBe(src.replace('Second <b>', 'Changed <b>'));
  });

  it('keeps the meaning when regenerating everything', () => {
    const src = `<task id="t"><title>Install <codeph>x</codeph></title><taskbody>
<steps><step><cmd>Run <i><b>this</b></i>.</cmd><info>More <xref href="a.dita"/> here.</info></step>
<step audience="admin"><cmd>Then.</cmd></step></steps>
<result><note type="tip">Done <!-- c --> now.</note></result>
</taskbody></task>`;
    const topic = load(src);
    const regenerated = topic.toSource(topic.doc, { regenerate: true });
    expect(canonical(parser(regenerated).documentElement)).toBe(
      canonical(parser(src).documentElement),
    );
    expect(regenerated).toContain('<step audience="admin">');
    expect(regenerated).toContain('<xref href="a.dita"/>');
    expect(regenerated).toContain('<!-- c -->');
  });

  it('adds, changes and removes the short description', () => {
    const src = '<topic id="t">\n  <title>T</title>\n  <body><p>x</p></body>\n</topic>';
    const topic = load(src);
    const at = topic.doc.child(0).nodeSize + 1;
    const added = EditorState.create({ doc: topic.doc }).tr.insertText('New desc.', at).doc;
    const withDesc = topic.toSource(added);
    expect(withDesc).toBe(
      '<topic id="t">\n  <title>T</title>\n  <shortdesc>New desc.</shortdesc>\n  <body><p>x</p></body>\n</topic>',
    );
    const again = load(withDesc);
    const end = again.doc.child(0).nodeSize + again.doc.child(1).nodeSize - 1;
    const cleared = EditorState.create({ doc: again.doc }).tr.delete(at, end).doc;
    expect(again.toSource(cleared)).toBe(src);
  });

  it('offers every filtering attribute OpenD applies', () => {
    expect([...CONDITION_ATTRS].sort()).toEqual([...FILTER_ATTRIBUTES].sort());
  });

  it('keeps maps, wrappers and broken XML in source mode', () => {
    expect(VisualTopic.load('<map><topicref href="a.dita"/></map>', parser).ok).toBe(false);
    expect(VisualTopic.load('<topic id="t"><title>T</topic>', parser).ok).toBe(false);
    expect(VisualTopic.load('<dita><topic id="t"><title>T</title></topic></dita>', parser).ok).toBe(
      false,
    );
  });
});
