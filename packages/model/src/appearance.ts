import { z } from 'zod';

/**
 * How a site looks (its theme) and how its PDFs are laid out (their
 * template). Both have built-in presets; a project picks a PDF template in
 * `opend.config.yaml`, and a site's staff can set either in the admin
 * console, which then wins over the repository.
 */

/** A `#rrggbb` colour. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour')
  .transform((c) => c.toLowerCase());

/** The neutral colours of one scheme: text, secondary text, backgrounds and borders. */
export interface Neutrals {
  text: string;
  muted: string;
  surface: string;
  surfaceAlt: string;
  border: string;
}

export interface ThemePreset {
  label: string;
  description: string;
  /** Accent in the light and the dark scheme; `null` keeps the built-in (or repository) palette. */
  accent: { light: string; dark: string } | null;
  /** Text on the accent colour, per scheme. */
  onAccent?: { light: string; dark: string };
  /** Neutral family; `null` keeps the built-in green-grey neutrals. */
  neutrals: { light: Neutrals; dark: Neutrals } | null;
}

const COOL: ThemePreset['neutrals'] = {
  light: {
    text: '#1e293b',
    muted: '#5b6574',
    surface: '#ffffff',
    surfaceAlt: '#f5f7fa',
    border: '#e2e8f0',
  },
  dark: {
    text: '#e2e8f0',
    muted: '#9aa5b4',
    surface: '#0f141b',
    surfaceAlt: '#131a22',
    border: '#243040',
  },
};
const WARM: ThemePreset['neutrals'] = {
  light: {
    text: '#292524',
    muted: '#6b625b',
    surface: '#ffffff',
    surfaceAlt: '#f8f6f4',
    border: '#e7e2dd',
  },
  dark: {
    text: '#e7e5e4',
    muted: '#a8a29e',
    surface: '#171412',
    surfaceAlt: '#1c1917',
    border: '#2f2a26',
  },
};
const GREY: ThemePreset['neutrals'] = {
  light: {
    text: '#1f1f1f',
    muted: '#5f6368',
    surface: '#ffffff',
    surfaceAlt: '#f6f6f6',
    border: '#e3e3e3',
  },
  dark: {
    text: '#e6e6e6',
    muted: '#a0a0a0',
    surface: '#141414',
    surfaceAlt: '#1a1a1a',
    border: '#2c2c2c',
  },
};

/**
 * Built-in site themes. Every accent keeps AA contrast for text on it and
 * for it on the surface, in both schemes. `default` changes nothing, so the
 * repository's own theme (or OpenD's emerald) shows through.
 */
export const THEME_PRESETS = {
  default: {
    label: 'Default',
    description: 'OpenD emerald, or the repository’s own theme when it has one.',
    accent: null,
    neutrals: null,
  },
  ocean: {
    label: 'Ocean',
    description: 'Clear blue on cool slate greys.',
    accent: { light: '#0b6bcb', dark: '#5aa9f5' },
    onAccent: { light: '#ffffff', dark: '#04111f' },
    neutrals: COOL,
  },
  indigo: {
    label: 'Indigo',
    description: 'Deep indigo on cool slate greys.',
    accent: { light: '#4f46e5', dark: '#a5b4fc' },
    onAccent: { light: '#ffffff', dark: '#0b0d24' },
    neutrals: COOL,
  },
  violet: {
    label: 'Violet',
    description: 'Vivid violet on cool slate greys.',
    accent: { light: '#7c3aed', dark: '#c4a7ff' },
    onAccent: { light: '#ffffff', dark: '#170b2e' },
    neutrals: COOL,
  },
  teal: {
    label: 'Teal',
    description: 'Calm teal on cool slate greys.',
    accent: { light: '#0f766e', dark: '#2dd4bf' },
    onAccent: { light: '#ffffff', dark: '#03201d' },
    neutrals: COOL,
  },
  rose: {
    label: 'Rose',
    description: 'Warm crimson on stone greys.',
    accent: { light: '#be123c', dark: '#fb7185' },
    onAccent: { light: '#ffffff', dark: '#24060d' },
    neutrals: WARM,
  },
  amber: {
    label: 'Amber',
    description: 'Burnt amber on stone greys.',
    accent: { light: '#b45309', dark: '#f5b041' },
    onAccent: { light: '#ffffff', dark: '#1f1302' },
    neutrals: WARM,
  },
  graphite: {
    label: 'Graphite',
    description: 'Monochrome: near-black accents on neutral greys.',
    accent: { light: '#374151', dark: '#d1d5db' },
    onAccent: { light: '#ffffff', dark: '#111111' },
    neutrals: GREY,
  },
} satisfies Record<string, ThemePreset>;

export type ThemePresetId = keyof typeof THEME_PRESETS;

/** Body font choices. `default` keeps the built-in (or repository) font. */
export const THEME_FONTS = {
  default: { label: 'Default', stack: null },
  system: {
    label: 'System sans-serif',
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  humanist: {
    label: 'Humanist sans-serif',
    stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  },
  serif: {
    label: 'Serif',
    stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
  },
  rounded: {
    label: 'Rounded sans-serif',
    stack:
      "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif",
  },
  mono: {
    label: 'Monospace',
    stack: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace",
  },
} as const satisfies Record<string, { label: string; stack: string | null }>;

export type ThemeFontId = keyof typeof THEME_FONTS;

/** Corner radii (small, regular). */
export const THEME_RADII = {
  default: { label: 'Default', values: null },
  square: { label: 'Square', values: ['2px', '3px'] },
  round: { label: 'Round', values: ['10px', '16px'] },
} as const satisfies Record<string, { label: string; values: readonly [string, string] | null }>;

export type ThemeRadiusId = keyof typeof THEME_RADII;

/** Reading width of topic text. */
export const THEME_WIDTHS = {
  default: { label: 'Default', measure: null },
  narrow: { label: 'Narrow', measure: '40rem' },
  wide: { label: 'Wide', measure: '56rem' },
  full: { label: 'Full width', measure: 'none' },
} as const satisfies Record<string, { label: string; measure: string | null }>;

export type ThemeWidthId = keyof typeof THEME_WIDTHS;

export const COLOR_SCHEMES = {
  auto: 'Follow the reader’s system',
  light: 'Always light',
  dark: 'Always dark',
} as const;

export type ColorSchemeId = keyof typeof COLOR_SCHEMES;

/** Longest custom CSS the admin console stores, in characters. */
export const MAX_CUSTOM_CSS = 50_000;

const keyOf = <T extends Record<string, unknown>>(record: T) =>
  z.enum(Object.keys(record) as [keyof T & string, ...(keyof T & string)[]]);

/** A site theme set in the admin console. */
export const siteThemeSchema = z.object({
  preset: keyOf(THEME_PRESETS).default('default'),
  /** Overrides the preset's accent in the light scheme. */
  accent: hexColorSchema.optional(),
  /** Overrides the accent in the dark scheme; derived from `accent` when left out. */
  accentDark: hexColorSchema.optional(),
  font: keyOf(THEME_FONTS).default('default'),
  headingFont: keyOf(THEME_FONTS).default('default'),
  radius: keyOf(THEME_RADII).default('default'),
  width: keyOf(THEME_WIDTHS).default('default'),
  colorScheme: keyOf(COLOR_SCHEMES).default('auto'),
  /** Extra rules loaded last, after the repository's theme. */
  customCss: z.string().max(MAX_CUSTOM_CSS).default(''),
});

export type SiteTheme = z.infer<typeof siteThemeSchema>;

export const DEFAULT_SITE_THEME: SiteTheme = siteThemeSchema.parse({});

// ---- PDF templates ---------------------------------------------------------

export const PAGE_SIZES = {
  A4: { label: 'A4 (210 × 297 mm)', width: '210mm', height: '297mm' },
  Letter: { label: 'US Letter (8.5 × 11 in)', width: '8.5in', height: '11in' },
  Legal: { label: 'US Legal (8.5 × 14 in)', width: '8.5in', height: '14in' },
  A5: { label: 'A5 (148 × 210 mm)', width: '148mm', height: '210mm' },
} as const;

export type PageSizeId = keyof typeof PAGE_SIZES;

/** Page margins in millimetres: top, right, bottom, left. */
export const PDF_MARGINS = {
  normal: { label: 'Normal', mm: [20, 18, 18, 18] },
  narrow: { label: 'Narrow', mm: [14, 12, 14, 12] },
  wide: { label: 'Wide', mm: [26, 25, 24, 25] },
} as const satisfies Record<string, { label: string; mm: readonly number[] }>;

export type PdfMarginId = keyof typeof PDF_MARGINS;

/** Body text size in points. */
export const PDF_FONT_SIZES = {
  small: { label: 'Small (9.5 pt)', pt: 9.5 },
  normal: { label: 'Normal (10.5 pt)', pt: 10.5 },
  large: { label: 'Large (11.5 pt)', pt: 11.5 },
} as const;

export type PdfFontSizeId = keyof typeof PDF_FONT_SIZES;

export const PDF_COVERS = {
  classic: 'Classic: a title page with the title in the accent colour',
  banner: 'Banner: a title page with a full-width accent band',
  minimal: 'Minimal: a plain title page, left-aligned',
  none: 'None: a title block at the top of the first page',
} as const;

export type PdfCoverId = keyof typeof PDF_COVERS;

/** Text for the running header and footer; these placeholders are filled in. */
export const PDF_PLACEHOLDERS = ['{title}', '{site}', '{release}', '{date}'] as const;

const runningText = z.string().max(200);

/** Every setting of a PDF template, as stored by the admin console. */
export const pdfTemplateSchema = z.object({
  /** The built-in template these settings started from. */
  template: z.enum(['standard', 'report', 'compact', 'handbook']).default('standard'),
  pageSize: keyOf(PAGE_SIZES),
  orientation: z.enum(['portrait', 'landscape']),
  margins: keyOf(PDF_MARGINS),
  fontSize: keyOf(PDF_FONT_SIZES),
  cover: keyOf(PDF_COVERS),
  /** A line on the cover, such as "Confidential". */
  coverNote: z.string().max(200),
  toc: z.boolean(),
  /** Start every top-level chapter on a new page. */
  chapterBreaks: z.boolean(),
  /** Running header text; empty for none. */
  header: runningText,
  /** Running footer text, before the page number; empty for none. */
  footer: runningText,
  pageNumbers: z.boolean(),
  /** Font for the PDF body; `default` follows the site theme. */
  font: keyOf(THEME_FONTS),
  /** Print rules loaded last. */
  customCss: z.string().max(MAX_CUSTOM_CSS),
});

export type PdfTemplate = z.infer<typeof pdfTemplateSchema>;
export type PdfTemplateId = PdfTemplate['template'];

const STANDARD: PdfTemplate = {
  template: 'standard',
  pageSize: 'A4',
  orientation: 'portrait',
  margins: 'normal',
  fontSize: 'normal',
  cover: 'classic',
  coverNote: '',
  toc: true,
  chapterBreaks: true,
  header: '{title}',
  footer: '',
  pageNumbers: true,
  font: 'default',
  customCss: '',
};

/** Built-in PDF templates: starting points that a project or the admin console adjusts. */
export const PDF_TEMPLATES: Record<
  PdfTemplateId,
  { label: string; description: string; settings: PdfTemplate }
> = {
  standard: {
    label: 'Standard',
    description: 'A4 with a title page, contents and a chapter per page.',
    settings: STANDARD,
  },
  report: {
    label: 'Report',
    description: 'US Letter with a banner title page and the release in the footer.',
    settings: {
      ...STANDARD,
      template: 'report',
      pageSize: 'Letter',
      margins: 'wide',
      cover: 'banner',
      header: '{site}',
      footer: '{title} · Release {release}',
    },
  },
  compact: {
    label: 'Compact',
    description: 'Dense A4 for printing: no title page, small text, chapters run on.',
    settings: {
      ...STANDARD,
      template: 'compact',
      margins: 'narrow',
      fontSize: 'small',
      cover: 'none',
      chapterBreaks: false,
    },
  },
  handbook: {
    label: 'Handbook',
    description: 'Pocket-sized A5 in a serif face, with a plain title page.',
    settings: {
      ...STANDARD,
      template: 'handbook',
      pageSize: 'A5',
      margins: 'narrow',
      fontSize: 'normal',
      cover: 'minimal',
      header: '',
      footer: '{title}',
      font: 'serif',
    },
  },
};

/**
 * `pdf` in `opend.config.yaml`: a built-in template and any settings to
 * change in it. Custom print CSS belongs in the project's `theme`.
 */
export const pdfConfigSchema = pdfTemplateSchema.omit({ customCss: true }).partial().strict();

export type PdfConfig = z.infer<typeof pdfConfigSchema>;

/** A whole template from a partial one: the named built-in template, then the given settings. */
export function resolvePdfTemplate(partial: Partial<PdfTemplate> | undefined | null): PdfTemplate {
  const base = PDF_TEMPLATES[partial?.template ?? 'standard'].settings;
  const defined = Object.fromEntries(
    Object.entries(partial ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<PdfTemplate>;
  return { ...base, ...defined };
}

/** Fills the running-text placeholders. The result is plain text: escape it for HTML. */
export function fillPlaceholders(
  text: string,
  values: { title: string; site: string; release: string; date: string },
): string {
  return text.replace(/\{(title|site|release|date)\}/g, (_, k: keyof typeof values) => values[k]);
}
