import type { ReaderContext } from '@opend/model';

// Shared by the stage 1 leak test and the hosted delivery leak test, so both
// check the same phrases with the same rules.

export type Rule = (c: ReaderContext) => boolean;
const has =
  (field: 'products' | 'features', value: string): Rule =>
  (c) =>
    c[field].includes(value);
const major = (c: ReaderContext) => Number(c.version.split('.')[0]);
const v2: Rule = (c) => major(c) >= 2;
const all =
  (...rules: Rule[]): Rule =>
  (c) =>
    rules.every((r) => r(c));
const never: Rule = () => false;

/**
 * Phrases from the starter template and who may see them. Each phrase appears
 * only in content with exactly that condition.
 */
export const MARKERS: [string, Rule][] = [
  ['Run the legacy installer', (c) => !v2(c)],
  ['Run the setup wizard', v2],
  ['Release notes for 1.x', (c) => major(c) === 1],
  ['Release notes for 2.x', v2],
  ['Pair the Gadget after installing', has('products', 'gadget')],
  ['Your licence includes the Gadget', has('products', 'gadget')],
  ['Pair a Gadget', has('products', 'gadget')],
  ['>Gadget<', has('products', 'gadget')],
  ['Single sign-on is available', has('features', 'sso')],
  ['Configure single sign-on', has('features', 'sso')],
  ['Enterprise Edition', has('features', 'sso')],
  ['Standard Edition', (c) => !has('features', 'sso')(c)],
  ['Just-in-time provisioning', all(has('features', 'sso'), v2)],
  ['Audit log events', all(has('features', 'audit-log'), v2)],
  ['sso.assertion', all(has('features', 'audit-log'), has('features', 'sso'), v2)],
  ['INTERNAL:', never],
  ['Escalation procedure', never],
  ['staff paging tool', never],
];
