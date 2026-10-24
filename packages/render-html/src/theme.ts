import {
  fillPlaceholders,
  PAGE_SIZES,
  PDF_FONT_SIZES,
  PDF_MARGINS,
  THEME_FONTS,
  THEME_PRESETS,
  THEME_RADII,
  THEME_WIDTHS,
  type Neutrals,
  type PdfTemplate,
  type SiteTheme,
  type ThemePreset,
} from '@opend/model';

/**
 * The built-in palette of `DEFAULT_CSS`, per scheme, so a theme that forces
 * one scheme can restate it. A test keeps these in step with the stylesheet.
 */
export const BASE_PALETTE = {
  light: {
    accent: '#187f65',
    text: '#1d2733',
    muted: '#5a6673',
    surface: '#ffffff',
    surfaceAlt: '#f5f7f6',
    border: '#e1e7e4',
    warn: '#a5520f',
    danger: '#b3261e',
    info: '#2457c5',
    cond: '#6b3fd1',
    onAccent: '#ffffff',
    tint: '#000000',
    shadow: '0 1px 2px rgb(16 24 22 / 0.04), 0 8px 24px -12px rgb(16 24 22 / 0.16)',
  },
  dark: {
    accent: '#3fbf98',
    text: '#dfe7e3',
    muted: '#9aa8a2',
    surface: '#111816',
    surfaceAlt: '#141c19',
    border: '#233029',
    warn: '#f0b46a',
    danger: '#ff9b91',
    info: '#8db0ff',
    cond: '#b9a0ff',
    onAccent: '#04140f',
    tint: '#ffffff',
    shadow: '0 1px 0 rgb(255 255 255 / 0.02), 0 12px 32px -16px rgb(0 0 0 / 0.7)',
  },
} as const;

type Scheme = 'light' | 'dark';
type Palette = Record<keyof (typeof BASE_PALETTE)['light'], string>;

const TOKEN: Record<keyof Palette, string> = {
  accent: '--opend-accent',
  text: '--opend-text',
  muted: '--opend-muted',
  surface: '--opend-surface',
  surfaceAlt: '--opend-surface-alt',
  border: '--opend-border',
  warn: '--opend-warn',
  danger: '--opend-danger',
  info: '--opend-info',
  cond: '--opend-cond',
  onAccent: '--opend-on-accent',
  tint: '--opend-tint',
  shadow: '--opend-shadow',
};

/** Derived link and highlight colours, which `DEFAULT_CSS` mixes differently per scheme. */
const DERIVED: Record<Scheme, string> = {
  light:
    '--opend-link: color-mix(in srgb, var(--opend-accent) 82%, var(--opend-tint)); --opend-link-hover: color-mix(in srgb, var(--opend-accent) 64%, var(--opend-tint)); --opend-accent-soft: color-mix(in srgb, var(--opend-accent) 12%, var(--opend-surface));',
  dark: '--opend-link: color-mix(in srgb, var(--opend-accent) 72%, var(--opend-tint)); --opend-link-hover: color-mix(in srgb, var(--opend-accent) 55%, var(--opend-tint)); --opend-accent-soft: color-mix(in srgb, var(--opend-accent) 16%, var(--opend-surface));',
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** White or near-black, whichever reads better on `accent`. */
function textOn(accent: string): string {
  return contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#0b0f0e')
    ? '#ffffff'
    : '#0b0f0e';
}

/** The tokens a theme changes in one scheme: its preset, then its own accent. */
function themeTokens(theme: SiteTheme, scheme: Scheme): Partial<Palette> {
  const preset: ThemePreset = THEME_PRESETS[theme.preset];
  const tokens: Partial<Palette> = {};
  const neutrals: Neutrals | undefined = preset.neutrals?.[scheme];
  if (neutrals) Object.assign(tokens, neutrals);
  if (preset.accent) tokens.accent = preset.accent[scheme];
  if (preset.onAccent) tokens.onAccent = preset.onAccent[scheme];
  if (scheme === 'light' && theme.accent) {
    tokens.accent = theme.accent;
    tokens.onAccent = textOn(theme.accent);
  }
  if (scheme === 'dark') {
    if (theme.accentDark) {
      tokens.accent = theme.accentDark;
      tokens.onAccent = textOn(theme.accentDark);
    } else if (theme.accent) {
      // A lighter tint of the light-scheme accent reads on dark surfaces.
      tokens.accent = `color-mix(in srgb, ${theme.accent} 62%, #ffffff)`;
      tokens.onAccent = '#0b0f0e';
    }
  }
  return tokens;
}

const declarations = (tokens: Partial<Palette>): string =>
  (Object.keys(tokens) as (keyof Palette)[]).map((k) => `${TOKEN[k]}: ${tokens[k]};`).join(' ');

/** Keeps CSS text inside a `<style>` element. */
export function styleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/**
 * The stylesheet for a site theme set in the admin console: it loads after
 * the built-in styles and the repository's theme, and overrides the
 * `--opend-*` properties the theme changes. An all-default theme with no
 * custom CSS is the empty string. `print` leaves out the dark scheme and
 * any forced scheme, as PDFs always print light.
 */
export function siteThemeCss(theme: SiteTheme, options: { print?: boolean } = {}): string {
  const rules: string[] = [];
  const light = themeTokens(theme, 'light');
  const dark = themeTokens(theme, 'dark');
  const scheme = options.print ? 'auto' : theme.colorScheme;

  if (scheme === 'light') {
    const all = { ...BASE_PALETTE.light, ...light };
    rules.push(`:root { color-scheme: light; ${declarations(all)} }`);
    rules.push(
      `@media (prefers-color-scheme: dark) { :root { ${declarations(all)} ${DERIVED.light} } }`,
    );
  } else if (scheme === 'dark') {
    const all = { ...BASE_PALETTE.dark, ...dark };
    rules.push(`:root { color-scheme: dark; ${declarations(all)} ${DERIVED.dark} }`);
  } else {
    if (Object.keys(light).length) rules.push(`:root { ${declarations(light)} }`);
    if (!options.print && Object.keys(dark).length)
      rules.push(`@media (prefers-color-scheme: dark) { :root { ${declarations(dark)} } }`);
  }

  const vars: string[] = [];
  const font = THEME_FONTS[theme.font].stack;
  if (font) vars.push(`--opend-font: ${font};`);
  const radii = THEME_RADII[theme.radius].values;
  if (radii) vars.push(`--opend-radius-sm: ${radii[0]};`, `--opend-radius: ${radii[1]};`);
  const measure = THEME_WIDTHS[theme.width].measure;
  if (measure && !options.print) vars.push(`--opend-measure: ${measure};`);
  if (vars.length) rules.push(`:root { ${vars.join(' ')} }`);
  const headings = THEME_FONTS[theme.headingFont].stack;
  if (headings) rules.push(`h1, h2, h3, h4, h5, h6, .site-title { font-family: ${headings}; }`);

  const custom = theme.customCss.trim();
  if (custom) rules.push(`/* Custom CSS from the admin console */\n${custom}`);
  return rules.length ? `${rules.join('\n')}\n` : '';
}

// ---- PDF templates ---------------------------------------------------------

const MM_PER_IN = 25.4;
const toMm = (length: string): number =>
  length.endsWith('in') ? parseFloat(length) * MM_PER_IN : parseFloat(length);

/** Page width and height in millimetres, after orientation. */
function pageMm(template: PdfTemplate): { width: number; height: number } {
  const size = PAGE_SIZES[template.pageSize];
  const [w, h] = [toMm(size.width), toMm(size.height)];
  return template.orientation === 'landscape' ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Print rules for a PDF template: page size and margins (which must match
 * `pdfPrintLayout`), text size, chapter breaks and the cover's height. They
 * load after `PRINT_CSS`; the template's own custom CSS is not included.
 */
export function pdfTemplateCss(template: PdfTemplate): string {
  const [top, right, bottom, left] = PDF_MARGINS[template.margins].mm;
  const { height } = pageMm(template);
  const size = `${template.pageSize} ${template.orientation}`;
  const rules = [
    `@page { size: ${size}; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; }`,
    `body { font-size: ${PDF_FONT_SIZES[template.fontSize].pt}pt; }`,
    // Fills the first page, less a little slack so it never spills onto a second.
    `.pub-cover { min-height: ${Math.floor(height - top - bottom - 12)}mm; }`,
  ];
  const font = THEME_FONTS[template.font].stack;
  if (font) rules.push(`body { --opend-font: ${font}; font-family: ${font}; }`);
  if (!template.chapterBreaks)
    rules.push(
      '.pub-chapter { break-before: auto; page-break-before: auto; }',
      '.pub-toc { break-after: auto; page-break-after: auto; margin-bottom: 18pt; }',
    );
  return `${rules.join('\n')}\n`;
}

/** Page set-up for the PDF printer, matching `pdfTemplateCss`. */
export interface PrintLayout {
  format: string;
  landscape: boolean;
  margin: { top: string; right: string; bottom: string; left: string };
  /** Plain text of the running header and footer; empty for none. */
  headerText: string;
  footerText: string;
  pageNumbers: boolean;
}

/** The printer's page set-up for a template, with the placeholders in its running text filled. */
export function pdfPrintLayout(
  template: PdfTemplate,
  values: { title: string; site: string; release: string; date: string },
): PrintLayout {
  const [top, right, bottom, left] = PDF_MARGINS[template.margins].mm;
  return {
    format: template.pageSize,
    landscape: template.orientation === 'landscape',
    margin: { top: `${top}mm`, right: `${right}mm`, bottom: `${bottom}mm`, left: `${left}mm` },
    headerText: fillPlaceholders(template.header, values).trim(),
    footerText: fillPlaceholders(template.footer, values).trim(),
    pageNumbers: template.pageNumbers,
  };
}
