import { describe, expect, it } from 'vitest';
import {
  PDF_TEMPLATES,
  THEME_PRESETS,
  resolvePdfTemplate,
  siteThemeSchema,
  type SiteTheme,
} from '@opend/model';
import {
  BASE_PALETTE,
  DEFAULT_CSS,
  contrastRatio,
  pdfPrintLayout,
  pdfTemplateCss,
  siteThemeCss,
} from '../src/index.js';

const theme = (input: Partial<SiteTheme> = {}): SiteTheme => siteThemeSchema.parse(input);

describe('site themes', () => {
  it('restates the built-in palette exactly', () => {
    const [light, dark] = [
      DEFAULT_CSS.slice(0, DEFAULT_CSS.indexOf('@media')),
      DEFAULT_CSS.slice(DEFAULT_CSS.indexOf('@media'), DEFAULT_CSS.indexOf('/* Derived')),
    ];
    const check = (block: string, palette: Record<string, string>) => {
      for (const [key, value] of Object.entries(palette)) {
        const token = `--opend-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        expect(block, token).toContain(`${token}: ${value};`);
      }
    };
    check(light, BASE_PALETTE.light);
    check(dark, BASE_PALETTE.dark);
  });

  it('changes nothing with every option on its default', () => {
    expect(siteThemeCss(theme())).toBe('');
  });

  it('keeps every preset readable in both schemes', () => {
    for (const [id, preset] of Object.entries(THEME_PRESETS)) {
      if (!preset.accent) continue;
      const on = preset.onAccent!;
      const n = preset.neutrals!;
      expect(contrastRatio(preset.accent.light, on.light), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(preset.accent.light, n.light.surface), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(preset.accent.dark, on.dark), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(preset.accent.dark, n.dark.surface), id).toBeGreaterThanOrEqual(4.5);
      for (const scheme of ['light', 'dark'] as const) {
        expect(contrastRatio(n[scheme].text, n[scheme].surface), id).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(n[scheme].muted, n[scheme].surfaceAlt), id).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('sets a preset’s accent and neutrals per scheme', () => {
    const css = siteThemeCss(theme({ preset: 'ocean' }));
    expect(css).toMatch(/^:root \{[^}]*--opend-accent: #0b6bcb;/);
    expect(css).toContain('--opend-surface-alt: #f5f7fa;');
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*--opend-accent: #5aa9f5;/,
    );
  });

  it('derives a dark accent and readable text on a custom accent', () => {
    const css = siteThemeCss(theme({ accent: '#ffcc00' }));
    expect(css).toContain('--opend-accent: #ffcc00; --opend-on-accent: #0b0f0e;');
    expect(css).toContain('--opend-accent: color-mix(in srgb, #ffcc00 62%, #ffffff);');
    expect(siteThemeCss(theme({ accent: '#123456', accentDark: '#abcdef' }))).toContain(
      '--opend-accent: #abcdef; --opend-on-accent: #0b0f0e;',
    );
  });

  it('forces one colour scheme on request', () => {
    const light = siteThemeCss(theme({ colorScheme: 'light' }));
    expect(light).toContain('color-scheme: light;');
    expect(light).toMatch(
      /@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*--opend-surface: #ffffff;/,
    );
    const dark = siteThemeCss(theme({ colorScheme: 'dark', preset: 'rose' }));
    expect(dark).toMatch(/^:root \{ color-scheme: dark;[^}]*--opend-accent: #fb7185;/);
    expect(dark).not.toContain('@media');
  });

  it('sets fonts, corners and width, then the custom CSS last', () => {
    const css = siteThemeCss(
      theme({
        font: 'serif',
        headingFont: 'mono',
        radius: 'square',
        width: 'wide',
        customCss: '.x { color: red }',
      }),
    );
    expect(css).toContain('--opend-font: Charter');
    expect(css).toContain('--opend-radius-sm: 2px; --opend-radius: 3px;');
    expect(css).toContain('--opend-measure: 56rem;');
    expect(css).toMatch(/h1, h2, h3, h4, h5, h6, \.site-title \{ font-family: ui-monospace/);
    expect(css.trimEnd().endsWith('.x { color: red }')).toBe(true);
  });

  it('prints light only', () => {
    const css = siteThemeCss(theme({ preset: 'violet', colorScheme: 'dark', width: 'wide' }), {
      print: true,
    });
    expect(css).toContain('--opend-accent: #7c3aed;');
    expect(css).not.toContain('dark');
    expect(css).not.toContain('--opend-measure');
  });

  it('rejects colours that are not #rrggbb and unknown options', () => {
    expect(siteThemeSchema.safeParse({ accent: 'red' }).success).toBe(false);
    expect(siteThemeSchema.safeParse({ preset: 'neon' }).success).toBe(false);
    expect(siteThemeSchema.parse({ accent: '#ABCDEF' }).accent).toBe('#abcdef');
  });
});

describe('PDF templates', () => {
  it('sets the page, margins and cover height from the template', () => {
    const css = pdfTemplateCss(
      resolvePdfTemplate({ template: 'report', orientation: 'landscape', margins: 'narrow' }),
    );
    expect(css).toContain('@page { size: Letter landscape; margin: 14mm 12mm 14mm 12mm; }');
    // 8.5in tall in landscape: 215.9 − 28 − 12.
    expect(css).toContain('.pub-cover { min-height: 175mm; }');
  });

  it('runs chapters on and drops the contents page break without chapter breaks', () => {
    const css = pdfTemplateCss(PDF_TEMPLATES.compact.settings);
    expect(css).toContain('.pub-chapter { break-before: auto;');
    expect(css).toContain('font-size: 9.5pt');
    expect(pdfTemplateCss(PDF_TEMPLATES.standard.settings)).not.toContain('break-before: auto');
  });

  it('fills the running text and matches the margins', () => {
    const layout = pdfPrintLayout(PDF_TEMPLATES.report.settings, {
      title: 'Admin Guide',
      site: 'Widget Docs',
      release: '2.1',
      date: '2026-10-23',
    });
    expect(layout).toEqual({
      format: 'Letter',
      landscape: false,
      margin: { top: '26mm', right: '25mm', bottom: '24mm', left: '25mm' },
      headerText: 'Widget Docs',
      footerText: 'Admin Guide · Release 2.1',
      pageNumbers: true,
    });
  });

  it('starts from a built-in template and applies the given settings', () => {
    const t = resolvePdfTemplate({ template: 'handbook', toc: false, pageSize: undefined });
    expect(t).toMatchObject({ template: 'handbook', pageSize: 'A5', font: 'serif', toc: false });
    expect(resolvePdfTemplate(undefined)).toEqual(PDF_TEMPLATES.standard.settings);
  });
});
