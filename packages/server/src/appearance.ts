import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  pdfTemplateSchema,
  resolvePdfTemplate,
  siteThemeSchema,
  type PdfConfig,
  type PdfTemplate,
  type SiteTheme,
} from '@opend/model';
import { BASE_PALETTE, contrastRatio, siteThemeCss } from '@opend/render-html';
import { SETTING, type SettingsSnapshot } from '@opend/store';
import type { AppContext } from './context.js';

/**
 * The site theme and PDF template set in the admin console. Both are stored
 * settings, so a change reaches every process through `NOTIFY`; pages,
 * the theme stylesheet's URL and PDF blob keys all carry `version`, so
 * nothing rendered with the old look is served again.
 */
export interface Appearance {
  /** The stored site theme, or `null` for the repository's own look. */
  theme: SiteTheme | null;
  /** The stored PDF template, or `null` to follow the repository's `pdf` settings. */
  pdf: PdfTemplate | null;
  /** The site stylesheet for `theme`; empty when it changes nothing. */
  css: string;
  /** The same theme for print: light only. */
  printCss: string;
  /** Short hash of both settings; empty when neither is set. */
  version: string;
}

/** The stored site theme, if it is valid. */
export function storedSiteTheme(snapshot: SettingsSnapshot): SiteTheme | null {
  const parsed = siteThemeSchema.safeParse(snapshot.values[SETTING.siteTheme]);
  return parsed.success ? parsed.data : null;
}

/** The stored PDF template, if it is valid. */
export function storedPdfTemplate(snapshot: SettingsSnapshot): PdfTemplate | null {
  const value = snapshot.values[SETTING.pdfTemplate];
  if (value === undefined) return null;
  const parsed = pdfTemplateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Least contrast a custom accent needs against the surface of its scheme. */
export const MIN_ACCENT_CONTRAST = 3;

/**
 * Why a theme's custom accents would be hard to read, or `null`. Links are
 * darkened (or lightened) from the accent and button text picks the better
 * of white and black, so 3:1 against the surface keeps both legible.
 */
export function accentProblem(theme: SiteTheme): string | null {
  if (theme.accent && contrastRatio(theme.accent, BASE_PALETTE.light.surface) < MIN_ACCENT_CONTRAST)
    return `The light-scheme accent ${theme.accent} is too pale to read on white: choose a darker colour.`;
  if (
    theme.accentDark &&
    contrastRatio(theme.accentDark, BASE_PALETTE.dark.surface) < MIN_ACCENT_CONTRAST
  )
    return `The dark-scheme accent ${theme.accentDark} is too dark to read on a dark background: choose a lighter colour.`;
  return null;
}

const computed = new WeakMap<SettingsSnapshot, Appearance>();

/** The appearance settings of a snapshot, computed once per snapshot. */
export function appearanceOf(snapshot: SettingsSnapshot): Appearance {
  let a = computed.get(snapshot);
  if (!a) {
    const theme = storedSiteTheme(snapshot);
    const pdf = storedPdfTemplate(snapshot);
    const version =
      theme || pdf
        ? createHash('sha256')
            .update(JSON.stringify([theme, pdf]))
            .digest('hex')
            .slice(0, 12)
        : '';
    a = {
      theme,
      pdf,
      css: theme ? siteThemeCss(theme) : '',
      printCss: theme ? siteThemeCss(theme, { print: true }) : '',
      version,
    };
    computed.set(snapshot, a);
  }
  return a;
}

/** The current appearance of this process. */
export function appearance(ctx: AppContext): Appearance {
  return appearanceOf(ctx.settings.current);
}

/** The PDF template in force: the admin console's, else the release's `pdf` settings. */
export function effectivePdfTemplate(a: Appearance, release: PdfConfig | undefined): PdfTemplate {
  return a.pdf ?? resolvePdfTemplate(release);
}

/** URL of the site theme stylesheet, or `undefined` when the theme changes nothing. */
export function siteThemeHref(a: Appearance): string | undefined {
  return a.css ? `${SITE_THEME_PATH}?v=${a.version}` : undefined;
}

export const SITE_THEME_PATH = '/_site-theme.css';

/**
 * `GET /_site-theme.css`: the site theme's stylesheet. It holds only what
 * staff chose in the console, nothing per reader, so it needs no session
 * (the sign-in page of a private site can use it too). Versioned URLs are
 * cached for good; others are revalidated.
 */
export function registerAppearance(app: FastifyInstance, ctx: AppContext): void {
  app.get(SITE_THEME_PATH, async (request, reply) => {
    const a = appearance(ctx);
    const v = (request.query as { v?: unknown }).v;
    return reply
      .headers({
        'cache-control':
          a.version && v === a.version ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      .type('text/css; charset=utf-8')
      .send(a.css);
  });
}
