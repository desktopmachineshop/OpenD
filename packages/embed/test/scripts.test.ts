import { describe, expect, it } from 'vitest';
import { frameScript, widgetScript } from '../src/index.js';

describe('served scripts', () => {
  it('are self-contained scripts that parse', () => {
    for (const script of [widgetScript(), frameScript()]) {
      expect(() => new Function(script)).not.toThrow();
      expect(script).not.toMatch(/\bimport\b|\bexport\b|require\(/);
    }
  });

  it('never post messages to a wildcard origin', () => {
    expect(widgetScript()).not.toContain("'*'");
    expect(frameScript()).not.toContain("'*'");
  });
});
