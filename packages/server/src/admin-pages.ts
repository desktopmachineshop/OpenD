import { DEFAULT_CSS, escapeHtml } from '@opend/render-html';
import {
  COLOR_SCHEMES,
  MAX_CUSTOM_CSS,
  PAGE_SIZES,
  PDF_COVERS,
  PDF_FONT_SIZES,
  PDF_MARGINS,
  PDF_TEMPLATES,
  THEME_FONTS,
  THEME_PRESETS,
  THEME_RADII,
  THEME_WIDTHS,
  type Diagnostic,
  type PdfTemplate,
  type SiteTheme,
} from '@opend/model';
import type {
  ApiKey,
  ApiScope,
  BuildJob,
  EditorUser,
  LiveRelease,
  Org,
  Reader,
  Repo,
} from '@opend/store';
import type { BrokerDomain, BrokerDomainStatus } from '@opend/worker';
import { ADMIN_CSS } from './admin-style.js';
import type { PickableRepo } from './github-connect.js';
import { GITHUB_ICON, KEY_ICON } from './pages.js';
import type { SettingSource } from './settings.js';

// ---- a small escaping template tag ------------------------------------------

/** Markup that is already safe. Only `html` and `raw` make one. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Trusted markup (constants, icons). Never pass data through here. */
export const raw = (markup: string): Html => new Html(markup);

function part(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/** Escapes every interpolated value, except `Html` (from `html` or `raw`); arrays are joined. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => (out += part(v) + strings[i + 1]!));
  return new Html(out);
}

// ---- icons (24-unit strokes, currentColor) ---------------------------------

const icon = (d: string) =>
  raw(
    `<svg class="admin-stroke" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${d}</svg>`,
  );
const ICONS = {
  overview: icon(
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  ),
  site: icon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  ),
  source: icon(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.2 7.3"/>',
  ),
  people: icon(
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
  ),
  signIn: icon(
    '<path d="M14 3h5a2 2 0 012 2v14a2 2 0 01-2 2h-5"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  ),
  github: icon(
    '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  ),
  editor: icon('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>'),
  key: icon('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>'),
  appearance: icon(
    '<path d="M12 3a9 9 0 100 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7h2A4.6 4.6 0 0021 10.6C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7.2" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  ),
  domain: icon(
    '<path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1.2-1.2"/>',
  ),
  shield: icon(
    '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  ),
};
const MENU_ICON = raw(
  '<svg class="site-menu-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path class="site-menu-bars" d="M4 7h16M4 12h16M4 17h16"/><path class="site-menu-close" d="M6 6l12 12M18 6L6 18"/></svg>',
);

// ---- shell -----------------------------------------------------------------

export type AdminSection =
  | 'overview'
  | 'site'
  | 'domain'
  | 'source'
  | 'people'
  | 'appearance'
  | 'sign-in'
  | 'github'
  | 'editor'
  | 'api';

const NAV: { group: string; items: [AdminSection, string, string, Html][] }[] = [
  {
    group: 'Site',
    items: [
      ['overview', '/admin', 'Overview', ICONS.overview],
      ['site', '/admin/site', 'Site & access', ICONS.site],
      ['domain', '/admin/domain', 'Custom domain', ICONS.domain],
      ['source', '/admin/source', 'Docs source', ICONS.source],
      ['people', '/admin/people', 'People', ICONS.people],
      ['appearance', '/admin/appearance', 'Appearance', ICONS.appearance],
    ],
  },
  {
    group: 'Settings',
    items: [
      ['sign-in', '/admin/sign-in', 'Sign-in', ICONS.signIn],
      ['github', '/admin/github', 'GitHub', ICONS.github],
      ['editor', '/admin/editor', 'Editor', ICONS.editor],
      ['api', '/admin/api-keys', 'API & AI', ICONS.key],
    ],
  },
];

export interface Flash {
  kind: 'ok' | 'error' | 'warn';
  message: string;
}

export interface ShellOptions {
  title: string;
  section: AdminSection;
  siteTitle: string;
  reader: Pick<Reader, 'email' | 'name'>;
  csrf: string;
  flash?: Flash | null;
  /** Warnings shown on every page, such as unreadable stored secrets. */
  warnings?: string[];
}

function navList(current: AdminSection): Html {
  return html`${NAV.map(
    (g) =>
      html`<p class="admin-nav-label">${g.group}</p>
        <ul>
          ${g.items.map(
            ([id, href, label, svg]) =>
              html`<li>
                <a
                  class="admin-nav-link"
                  href="${href}"
                  ${raw(id === current ? ' aria-current="page"' : '')}
                  >${svg}${label}</a
                >
              </li>`,
          )}
        </ul>`,
  )}`;
}

export function flashBox(flash: Flash): Html {
  return html`<div
    class="admin-flash${flash.kind === 'ok' ? '' : ` is-${flash.kind}`}"
    role="${flash.kind === 'ok' ? 'status' : 'alert'}"
  >
    <p>${flash.message}</p>
  </div>`;
}

export function csrfField(csrf: string): Html {
  return html`<input type="hidden" name="_csrf" value="${csrf}" />`;
}

/** The admin page: the docs site's header, a sidebar of sections, and the menu panel on phones. */
export function adminShell(o: ShellOptions, body: Html): string {
  const display = o.reader.name?.trim() || o.reader.email;
  const signOut = html`<form method="post" action="/auth/logout">
    ${csrfField(o.csrf)}<button type="submit">Sign out</button>
  </form>`;
  const nav = navList(o.section);
  const notices = [
    ...(o.warnings ?? []).map((w) => flashBox({ kind: 'warn', message: w })),
    ...(o.flash ? [flashBox(o.flash)] : []),
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(`${o.title} · Admin · ${o.siteTitle}`)}</title>
<style>${DEFAULT_CSS}${ADMIN_CSS}</style>
</head>
<body class="opend-site opend-admin">
${html`<a class="opend-skip" href="#opend-main">Skip to content</a>
  <header class="site-header">
    <details class="site-menu">
      <summary aria-controls="opend-menu-panel">
        <span class="site-menu-button">${MENU_ICON}<span>Menu</span></span>
      </summary>
      <div class="site-menu-panel" id="opend-menu-panel">
        <nav class="opend-nav" aria-label="Admin sections">${nav}</nav>
        <div class="site-menu-account">
          <p class="site-menu-who">Signed in as <strong>${display}</strong> (staff)</p>
          <p class="site-menu-who"><a href="/">View the documentation</a></p>
          ${signOut}
        </div>
      </div>
    </details>
    <a class="site-title" href="/admin"
      ><span class="admin-mark">${ICONS.shield}</span><span>${o.siteTitle}</span></a
    ><span class="site-release">Admin</span><a class="admin-view-site" href="/">View site</a>
    <div class="site-account">
      <span class="site-account-who" title="${o.reader.email}"
        ><span class="site-avatar" aria-hidden="true">${Array.from(display)[0] ?? '?'}</span
        ><span class="site-account-name"
          ><span class="opend-visually-hidden">Signed in as </span>${display}</span
        ></span
      >${signOut}
    </div>
  </header>
  <div class="layout">
    <nav class="toc opend-nav" aria-label="Admin sections">${nav}</nav>
    <main id="opend-main"><div class="admin-page">${notices}${body}</div></main>
  </div>`}
</body>
</html>
`;
}

function head(eyebrow: string, title: string, lead: string | Html): Html {
  return html`<div class="admin-head">
    <p class="admin-eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="admin-lead">${lead}</p>
  </div>`;
}

function badge(text: string, kind: 'ok' | 'warn' | 'danger' | 'info' | 'muted' = 'muted'): Html {
  return html`<span class="admin-badge${kind === 'muted' ? '' : ` is-${kind}`}">${text}</span>`;
}

/** The site settings the repository's `opend.config.yaml` declares (`site:`), by field. */
function declaredSet(repo: Repo | null): Set<string> {
  return new Set(
    Object.entries(repo?.declared?.settings ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k),
  );
}

const REPO_SET = 'Set by opend.config.yaml';

/** Where repository-declared settings came from, and how to change them. */
function declaredHint(repo: Repo): Html {
  const d = repo.declared;
  return html`<p class="admin-hint">
    Set by the <code>site:</code> block of
    <code>opend.config.yaml</code
    >${d ? html` on <code>${d.ref}</code> (commit <code>${d.sha.slice(0, 7)}</code>)` : ''}. Change
    it in the docs repository: the next build applies it.
  </p>`;
}

const SOURCE_LABEL: Record<SettingSource, [string, 'ok' | 'info' | 'muted']> = {
  env: ['Set by environment', 'info'],
  console: ['Set here', 'ok'],
  broker: ['Hosting provider', 'info'],
  none: ['Not set', 'muted'],
};
export function sourceBadge(source: SettingSource): Html {
  const [label, kind] = SOURCE_LABEL[source];
  return badge(label, kind);
}

const time = (d: Date | string | null) => {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return html`<time datetime="${date.toISOString()}"
    >${date.toISOString().slice(0, 16).replace('T', ' ')} UTC</time
  >`;
};

function confirmButton(o: {
  action: string;
  csrf: string;
  label: string;
  question: string;
  fields?: Record<string, string | number>;
}): Html {
  const hidden = Object.entries(o.fields ?? {}).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${String(v)}" />`,
  );
  return html`<details class="admin-confirm">
    <summary class="admin-button is-danger is-small">${o.label}</summary>
    <form class="admin-confirm-panel" method="post" action="${o.action}">
      ${csrfField(o.csrf)}${hidden}
      <p>${o.question}</p>
      <button class="admin-button is-danger is-small" type="submit">${o.label}</button>
    </form>
  </details>`;
}

function postButton(o: {
  action: string;
  csrf: string;
  label: string;
  fields?: Record<string, string | number>;
  style?: 'secondary' | 'primary';
}): Html {
  const hidden = Object.entries(o.fields ?? {}).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${String(v)}" />`,
  );
  return html`<form class="admin-inline" method="post" action="${o.action}">
    ${csrfField(o.csrf)}${hidden}<button
      class="admin-button is-small${o.style === 'primary' ? '' : ' is-secondary'}"
      type="submit"
    >
      ${o.label}
    </button>
  </form>`;
}

function field(o: {
  name: string;
  label: string;
  value?: string;
  type?: 'text' | 'email' | 'url' | 'password';
  hint?: string | Html;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autocomplete?: string;
}): Html {
  const id = `f-${o.name}`;
  const hintId = o.hint ? `${id}-hint` : '';
  return html`<div class="admin-field">
    <label for="${id}">${o.label}</label
    ><input
      id="${id}"
      name="${o.name}"
      type="${o.type ?? 'text'}"
      value="${o.value ?? ''}"
      ${raw(o.required ? ' required' : '')}${raw(o.disabled ? ' disabled' : '')}${o.placeholder ? html` placeholder="${o.placeholder}"` : ''}${hintId ? html` aria-describedby="${hintId}"` : ''}
      autocomplete="${o.autocomplete ?? 'off'}"
    />${o.hint ? html`<p class="admin-hint" id="${hintId}">${o.hint}</p>` : ''}
  </div>`;
}

/** Checkboxes named `<prefix>:<value>`, since a form field name may repeat only once here. */
function choices(o: {
  legend: string;
  prefix: string;
  values: string[];
  checked: readonly string[];
  hint?: string;
  disabled?: boolean;
}): Html {
  const all = [...new Set([...o.values, ...o.checked])];
  if (all.length === 0) return html``;
  return html`<fieldset class="admin-fieldset">
    <legend class="admin-legend">${o.legend}</legend>
    <div class="admin-choices">
      ${all.map(
        (v) =>
          html`<label class="admin-choice"
            ><input
              type="checkbox"
              name="${`${o.prefix}:${v}`}"
              value="1"
              ${raw(o.checked.includes(v) ? ' checked' : '')}${raw(o.disabled ? ' disabled' : '')}
            />${v}</label
          >`,
      )}
    </div>
    ${o.hint ? html`<p class="admin-hint">${o.hint}</p>` : ''}
  </fieldset>`;
}

// ---- overview --------------------------------------------------------------

export interface OverviewData {
  repo: Repo | null;
  repoCount: number;
  live: LiveRelease[];
  jobs: (BuildJob & { repoName: string })[];
  readers: number;
  staff: number;
  orgs: number;
  audit: { at: Date; actor: string; action: string }[];
  github: SettingSource;
  publicUrl: string;
  /** What automatic setup did on this visit: connected the docs source, or why it could not. */
  autoConnect?:
    | { status: 'connected'; repo: Repo; configPath: string; builds: number }
    | { status: 'manual'; reason: string }
    | { status: 'idle' };
}

const JOB_BADGE: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  succeeded: 'ok',
  queued: 'info',
  running: 'info',
  failed: 'danger',
};

function diagnosticsList(diagnostics: Diagnostic[]): Html {
  const shown = diagnostics.slice(0, 50);
  return html`<ul class="admin-diag">
    ${shown.map(
      (d) =>
        html`<li>
          ${badge(d.severity, d.severity === 'error' ? 'danger' : 'warn')}
          <code>${`${d.file ?? ''}${d.line ? `:${d.line}` : ''}`}</code> ${d.code}: ${d.message}
        </li>`,
    )}${diagnostics.length > shown.length ? html`<li>…and ${diagnostics.length - shown.length} more</li>` : ''}
  </ul>`;
}

export function buildsTable(jobs: OverviewData['jobs']): Html {
  if (jobs.length === 0) return html`<p class="admin-empty">No builds yet.</p>`;
  return html`<div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th scope="col">Build</th>
          <th scope="col">Status</th>
          <th scope="col">Ref</th>
          <th scope="col">Commit</th>
          <th scope="col">Started</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(
          (j) =>
            html`<tr>
              <td>#${j.id}<br /><span class="admin-muted">${j.repoName}</span></td>
              <td>
                ${badge(j.status, JOB_BADGE[j.status] ?? 'muted')}${
                  j.error || j.diagnostics.length
                    ? html`<details class="admin-details">
                        <summary>
                          ${j.diagnostics.filter((d) => d.severity === 'error').length || (j.error ? 1 : 0)}
                          problem(s)
                        </summary>
                        <div>
                          ${j.error ? html`<p>${j.error}</p>` : ''}${j.diagnostics.length ? diagnosticsList(j.diagnostics) : ''}
                        </div>
                      </details>`
                    : ''
                }
              </td>
              <td><code>${j.ref}</code></td>
              <td><code>${j.sha.slice(0, 7)}</code></td>
              <td>${time(j.createdAt)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function overviewPage(d: OverviewData): Html {
  const setup: Html[] = [];
  const auto = d.autoConnect;
  if (!d.repo)
    setup.push(
      html`<li>
        <strong>Register the docs repository.</strong>
        ${
          auto?.status === 'manual'
            ? html`<p>Automatic setup did not connect one: ${auto.reason}</p>`
            : ''
        }
        <p><a href="/admin/source">Docs source</a>: pick it from GitHub, or give its clone URL.</p>
      </li>`,
    );
  if (d.github === 'none')
    setup.push(
      html`<li>
        <strong>Connect GitHub</strong> for private repositories, builds on every push, GitHub
        sign-in and the web editor.
        <p><a href="/admin/github">GitHub</a></p>
      </li>`,
    );
  const lines = d.live.length
    ? html`<div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Release line</th>
              <th scope="col">Release</th>
              <th scope="col">Commit</th>
            </tr>
          </thead>
          <tbody>
            ${d.live.map(
              (l) =>
                html`<tr>
                  <td>${l.releaseLine}.x</td>
                  <td>${badge(l.release, 'ok')}</td>
                  <td><code>${l.sha.slice(0, 7)}</code></td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="admin-empty">
        Nothing is published yet. A build goes live when it passes validation.
      </p>`;
  return html`${head('Admin', 'Overview', 'What readers see right now, the latest builds, and recent changes.')}
    ${
      auto?.status === 'connected'
        ? flashBox({
            kind: 'ok',
            message: `Connected ${auto.repo.fullName} automatically: docs in ${auto.repo.docsPath === '.' ? 'the repository root' : `${auto.repo.docsPath}/`}, publishing ${auto.repo.releaseRefs.join(', ')} (from ${auto.configPath}). ${auto.builds} build(s) queued.`,
          })
        : ''
    }
    ${
      setup.length
        ? html`<section class="admin-card" aria-labelledby="setup-h">
            <h2 id="setup-h">Finish setting up</h2>
            <ol class="admin-steps">
              ${setup}
            </ol>
          </section>`
        : ''
    }
    <div class="admin-grid">
      <div class="admin-card admin-stat">
        <span class="admin-stat-label">Site</span
        ><span class="admin-stat-value"
          >${d.repo ? (d.repo.access === 'public' ? 'Public' : 'Private') : 'Not set up'}</span
        ><a href="/admin/site">Site & access</a>
      </div>
      <div class="admin-card admin-stat">
        <span class="admin-stat-label">Address</span
        ><span class="admin-stat-value">${hostOf(d.publicUrl)}</span
        ><a href="/admin/domain">Custom domain</a>
      </div>
      <div class="admin-card admin-stat">
        <span class="admin-stat-label">Docs repository</span
        ><span class="admin-stat-value"
          >${d.repo?.fullName ?? (d.repoCount > 1 ? `${d.repoCount} registered` : 'None')}</span
        ><a href="/admin/source">Docs source</a>
      </div>
      <div class="admin-card admin-stat">
        <span class="admin-stat-label">Readers</span
        ><span class="admin-stat-value">${d.readers}</span
        ><span class="admin-muted">${d.orgs} org(s), ${d.staff} staff</span>
      </div>
    </div>
    <section class="admin-card" aria-labelledby="live-h">
      <div class="admin-card-head">
        <h2 id="live-h">Live releases</h2>
        <a class="admin-button is-secondary is-small" href="/">Open the site</a>
      </div>
      ${
        d.repo
          ? html`<p class="admin-muted">
              ${
                d.repo.releaseLines === 'minor'
                  ? 'One live release per minor version (0.23.x, 0.24.x).'
                  : 'One live release per major version (1.x, 2.x).'
              }
              <a href="/admin/site#lines-h">Change release lines</a>
            </p>`
          : ''
      }
      ${lines}
    </section>
    <section class="admin-card" aria-labelledby="builds-h">
      <div class="admin-card-head">
        <h2 id="builds-h">Latest builds</h2>
        <a class="admin-button is-secondary is-small" href="/admin/source">Rebuild</a>
      </div>
      ${buildsTable(d.jobs)}
    </section>
    <section class="admin-card" aria-labelledby="audit-h">
      <h2 id="audit-h">Recent changes</h2>
      ${
        d.audit.length
          ? html`<div class="admin-table-wrap">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">What</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.audit.map(
                    (a) =>
                      html`<tr>
                        <td>${time(a.at)}</td>
                        <td>${a.actor}</td>
                        <td><code>${a.action}</code></td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<p class="admin-empty">No changes recorded yet.</p>`
      }
    </section>`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---- site & access ---------------------------------------------------------

export interface SitePageData {
  repo: Repo | null;
  repoCount: number;
  siteTitle: string;
  attributes: { product: string[]; feature: string[] };
  release: string | null;
  /** The live release of each line, newest first, e.g. `['2.1', '1.4']`. */
  published: string[];
  /** Where the site is served (`PUBLIC_URL`). */
  publicUrl: string;
  csrf: string;
}

const VERSION_MODES = [
  ['off', 'Off', 'No picker. Each reader gets the version their organization is entitled to.'],
  [
    'reader',
    'Reader’s version',
    'Show each signed-in reader the version they get, from their organization’s entitlements.',
  ],
  ['fixed', 'Fixed version', 'Everyone gets the one version below, whatever their own.'],
  [
    'list',
    'Choose from a list',
    'Readers pick from the versions below. Their own version is always offered too, and is where they start.',
  ],
  [
    'live',
    'Every live version',
    'Readers pick from every release line that is live, newest first. A new line appears when it is published and a retired one disappears: there is no list to keep up to date.',
  ],
] as const;

const RELEASE_LINE_MODES = [
  [
    'major',
    'By major version',
    'One live release for each major version, such as 2.x and 1.x. A 2.4 build replaces the live 2.3 docs.',
  ],
  [
    'minor',
    'By minor version',
    'One live release for each minor version, such as 0.23.x and 0.22.x. A 0.24 build goes live next to 0.23 instead of replacing it.',
  ],
] as const;

function releaseLinesForm(repo: Repo, published: string[], csrf: string): Html {
  const locked = declaredSet(repo).has('releaseLines');
  return html`<form
    class="admin-card admin-form"
    method="post"
    action="/admin/site/release-lines"
    aria-labelledby="lines-h"
  >
    ${csrfField(csrf)}
    <div class="admin-card-head">
      <h2 id="lines-h">Release lines</h2>
      ${locked ? badge(REPO_SET, 'info') : ''}
    </div>
    <p class="admin-hint">
      Each release line has one live release. Readers get the live release of their version’s line,
      and the version picker offers lines.
      ${published.length ? `Live now: ${published.join(', ')}.` : 'Nothing is live yet.'}
    </p>
    <fieldset class="admin-fieldset" ${raw(locked ? ' disabled' : '')}>
      <legend class="admin-legend">Group releases</legend>
      <div class="admin-options">
        ${RELEASE_LINE_MODES.map(
          ([lines, title, text]) =>
            html`<label class="admin-option"
              ><input
                type="radio"
                name="releaseLines"
                value="${lines}"
                ${raw(repo.releaseLines === lines ? ' checked' : '')}
              /><span><strong>${title}</strong><span>${text}</span></span></label
            >`,
        )}
      </div>
    </fieldset>
    <p class="admin-hint">
      Switching moves each live release to its line under the new grouping, straight away. Going to
      major versions, lines that merge keep the release built most recently. Going to minor
      versions, only the releases live now stay live: older minor versions come back when their
      branch or tag is built again.
    </p>
    ${
      locked
        ? declaredHint(repo)
        : html`<div class="admin-buttons">
            <button class="admin-button" type="submit">Save release lines</button>
          </div>`
    }
  </form>`;
}

function versionPickerForm(repo: Repo, published: string[], csrf: string): Html {
  const picker = repo.versionPicker;
  const fixed = picker.mode === 'fixed' ? picker.version : (published[0] ?? '');
  const list = picker.mode === 'list' ? picker.versions.join(', ') : published.join(', ');
  const hint = published.length
    ? `Published release lines: ${published.join(', ')}. Any version such as 2.0 or 1.4 works.`
    : 'A version such as 2.1.';
  const locked = declaredSet(repo).has('versionPicker');
  return html`<form
    class="admin-card admin-form"
    method="post"
    action="/admin/site/versions"
    aria-labelledby="versions-h"
  >
    ${csrfField(csrf)}
    <div class="admin-card-head">
      <h2 id="versions-h">Version picker</h2>
      ${locked ? badge(REPO_SET, 'info') : ''}
    </div>
    <p class="admin-hint">
      What readers see next to the site title, and which version of the docs they are served.
      Products and features still come from each reader’s entitlements. On a public site, anonymous
      visitors get the same choice.
    </p>
    <fieldset class="admin-fieldset" ${raw(locked ? ' disabled' : '')}>
      <legend class="admin-legend">What readers can choose</legend>
      <div class="admin-options">
        ${VERSION_MODES.map(
          ([mode, title, text]) =>
            html`<label class="admin-option"
              ><input
                type="radio"
                name="mode"
                value="${mode}"
                ${raw(picker.mode === mode ? ' checked' : '')}
              /><span><strong>${title}</strong><span>${text}</span></span></label
            >`,
        )}
      </div>
    </fieldset>
    <div class="admin-form-row">
      ${field({ name: 'fixedVersion', label: 'Fixed version', value: fixed, hint: 'For “Fixed version”.', disabled: locked })}${field({ name: 'versions', label: 'Versions in the list', value: list, hint: `For “Choose from a list”, comma-separated. ${hint}`, disabled: locked })}
    </div>
    ${
      locked
        ? declaredHint(repo)
        : html`<div class="admin-buttons">
            <button class="admin-button" type="submit">Save version picker</button>
          </div>`
    }
  </form>`;
}

export function sitePage(d: SitePageData): Html {
  const intro = head(
    'Site',
    'Site & access',
    'Who can read the documentation, and what anonymous visitors of a public site see.',
  );
  if (!d.repo)
    return html`${intro}
      <section class="admin-card">
        <h2>No site yet</h2>
        <p>
          ${
            d.repoCount > 1
              ? 'Several repositories are registered: set OPEND_SITE_REPO to the one the site serves.'
              : 'Register the docs repository first.'
          }
        </p>
        <p><a class="admin-button" href="/admin/source">Docs source</a></p>
      </section>`;
  const pub = d.repo.publicEntitlements;
  const declared = declaredSet(d.repo);
  const lockAccess = declared.has('access');
  const lockPublic = declared.has('publicEntitlements');
  return html`${intro}
    ${
      declared.size
        ? html`<section class="admin-card" aria-labelledby="declared-h">
            <div class="admin-card-head">
              <h2 id="declared-h">Set by the repository</h2>
              ${badge(REPO_SET, 'info')}
            </div>
            <p>
              The docs repository declares
              ${[...declared].map((f, i) => html`${i ? ', ' : ''}<code>${f}</code>`)} in the
              <code>site:</code> block of its <code>opend.config.yaml</code>. Those settings are
              read-only here; the rest stay yours to change.
            </p>
            ${declaredHint(d.repo)}
          </section>`
        : ''
    }
    <section class="admin-card" aria-labelledby="title-h">
      <h2 id="title-h">Site</h2>
      <dl class="admin-facts">
        <dt>Title</dt>
        <dd>
          ${d.siteTitle}
          <span class="admin-muted">(from <code>opend.config.yaml</code> in the repository)</span>
        </dd>
        <dt>Address</dt>
        <dd>
          <a href="${d.publicUrl}">${hostOf(d.publicUrl)}</a>
          <span class="admin-muted">(<a href="/admin/domain">Custom domain</a>)</span>
        </dd>
        <dt>Repository</dt>
        <dd><code>${d.repo.fullName}</code></dd>
        <dt>Newest release</dt>
        <dd>${d.release ?? 'none published'}</dd>
      </dl>
    </section>
    <form
      class="admin-card admin-form"
      method="post"
      action="/admin/site/access"
      aria-labelledby="access-h"
    >
      ${csrfField(d.csrf)}
      <div class="admin-card-head">
        <h2 id="access-h">Access</h2>
        ${lockAccess || lockPublic ? badge(REPO_SET, 'info') : ''}
      </div>
      <fieldset class="admin-fieldset" ${raw(lockAccess ? ' disabled' : '')}>
        <legend class="admin-legend">Who can read the site</legend>
        <div class="admin-options">
          <label class="admin-option"
            ><input
              type="radio"
              name="access"
              value="private"
              ${raw(d.repo.access === 'private' ? ' checked' : '')}
            /><span
              ><strong>Private</strong
              ><span
                >Only signed-in readers you have registered, each seeing what their organization is
                entitled to.</span
              ></span
            ></label
          >
          <label class="admin-option"
            ><input
              type="radio"
              name="access"
              value="public"
              ${raw(d.repo.access === 'public' ? ' checked' : '')}
            /><span
              ><strong>Public</strong
              ><span
                >Anyone can read, without signing in. Gated content stays gated: visitors see only
                what you allow below.</span
              ></span
            ></label
          >
        </div>
      </fieldset>
      <h3>What anonymous visitors of a public site see</h3>
      <p class="admin-hint">
        Content with no product, feature or release condition is always shown. Choose which gated
        content is public too. Signed-in readers keep their own entitlements as well.
      </p>
      ${choices({ legend: 'Products', prefix: 'product', values: d.attributes.product, checked: pub?.products ?? [], hint: d.attributes.product.length ? 'Declared in the published release’s opend.config.yaml.' : '', disabled: lockPublic })}
      ${choices({ legend: 'Features', prefix: 'feature', values: d.attributes.feature, checked: pub?.features ?? [], disabled: lockPublic })}
      ${d.attributes.product.length + d.attributes.feature.length === 0 && !pub ? html`<p class="admin-hint">The published release declares no products or features.</p>` : ''}
      <div class="admin-form-row">
        ${field({ name: 'version', label: 'Release version', value: lockPublic ? (pub?.version ?? '') : (pub?.version ?? d.release ?? ''), hint: 'Which release line visitors see, such as 2.1, or latest for the newest live line (it moves on by itself when a new line is published). Leave empty to show only ungated content on the newest line.', disabled: lockPublic })}
      </div>
      ${
        lockAccess && lockPublic
          ? declaredHint(d.repo)
          : html`${lockAccess || lockPublic ? declaredHint(d.repo) : ''}
              <div class="admin-buttons">
                <button class="admin-button" type="submit">Save access</button>
              </div>`
      }
    </form>
    ${releaseLinesForm(d.repo, d.published, d.csrf)}
    ${versionPickerForm(d.repo, d.published, d.csrf)}`;
}

// ---- custom domain ---------------------------------------------------------

export interface DomainPageData {
  /** Managed hosting: the provider attaches domains (through its broker). */
  managed: boolean;
  /** The site's address now (`PUBLIC_URL`). */
  publicUrl: string;
  /** What the provider reports; null when self-hosted or it could not be reached. */
  domain: BrokerDomain | null;
  /** Why the provider could not be asked. */
  loadError: string | null;
  csrf: string;
}

const DOMAIN_BADGE: Record<
  BrokerDomainStatus,
  [string, 'ok' | 'warn' | 'danger' | 'info' | 'muted']
> = {
  none: ['No custom domain', 'muted'],
  attaching: ['Being attached', 'info'],
  'awaiting-dns': ['Waiting for DNS', 'warn'],
  live: ['Live', 'ok'],
  error: ['Needs attention', 'danger'],
};

/** What the staff reader reads at each status, in plain words. */
function domainStatusText(d: BrokerDomain): string {
  const keeps = d.defaultAddress
    ? `${hostOf(d.defaultAddress)} keeps working`
    : 'The current address keeps working';
  switch (d.status) {
    case 'none':
      return `The site is served at its own address. Add a domain you own, such as docs.example.com, to serve it there too.`;
    case 'attaching':
      return `${d.domain} is being attached. The DNS records to add appear here in a few minutes: reload this page.`;
    case 'awaiting-dns':
      return `Add the records below at your DNS provider. The site keeps its own address until they have propagated, then switches to ${d.domain} by itself. ${keeps}.`;
    case 'live':
      return `The site is served at ${d.domain}. ${keeps} too, so existing links still work.`;
    case 'error':
      return d.error ?? `${d.domain} could not be attached.`;
  }
}

function dnsTable(d: BrokerDomain): Html {
  return html`<div class="admin-table-wrap">
    <table class="admin-table admin-dns">
      <caption class="opend-visually-hidden">
        DNS records for ${d.domain}
      </caption>
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col">Propagated</th>
        </tr>
      </thead>
      <tbody>
        ${d.records.map(
          (r) =>
            html`<tr>
              <td data-label="Type"><code>${r.type}</code></td>
              <td data-label="Name"><code class="admin-copy">${r.name}</code></td>
              <td data-label="Value"><code class="admin-copy">${r.value}</code></td>
              <td data-label="Propagated">
                ${r.propagated ? badge('✓ In place', 'ok') : badge('Pending', 'warn')}
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function domainPage(d: DomainPageData): Html {
  const intro = head(
    'Site',
    'Custom domain',
    'Serve the documentation at a domain you own, such as docs.example.com.',
  );
  if (!d.managed)
    return html`${intro}
      <section class="admin-card" aria-labelledby="domain-self-h">
        <h2 id="domain-self-h">Set by your server</h2>
        <dl class="admin-facts">
          <dt>Address</dt>
          <dd><a href="${d.publicUrl}">${d.publicUrl}</a></dd>
        </dl>
        <p>
          This site runs on your own server, so its address is whatever <code>PUBLIC_URL</code> says
          and your reverse proxy or hosting platform serves. To move it to another domain:
        </p>
        <ol class="admin-steps">
          <li>
            <strong>Point the domain at your server</strong>
            <p>At your DNS provider, add the record your server or platform asks for.</p>
          </li>
          <li>
            <strong>Serve it with HTTPS</strong>
            <p>Add the domain to your reverse proxy or platform, with a certificate.</p>
          </li>
          <li>
            <strong>Set <code>PUBLIC_URL</code> and restart</strong>
            <p>
              Links, sign-in callbacks and the editor follow it. Register the new callback with your
              sign-in provider and GitHub App before switching.
            </p>
          </li>
        </ol>
        <p class="admin-hint">There is nothing to set here: the console cannot change it.</p>
      </section>`;
  if (!d.domain)
    return html`${intro}
      <section class="admin-card" aria-labelledby="domain-h">
        <h2 id="domain-h">Not available right now</h2>
        <p>
          ${d.loadError ?? 'Your hosting provider did not answer.'} The site keeps working at
          <a href="${d.publicUrl}">${hostOf(d.publicUrl)}</a>. Reload the page to try again.
        </p>
      </section>`;
  const dom = d.domain;
  const [label, kind] = DOMAIN_BADGE[dom.status];
  return html`${intro}
    <section class="admin-card" aria-labelledby="domain-h">
      <div class="admin-card-head">
        <h2 id="domain-h">Status</h2>
        ${badge(label, kind)}
      </div>
      <dl class="admin-facts">
        <dt>Address now</dt>
        <dd>
          ${dom.publicUrl ? html`<a href="${dom.publicUrl}">${hostOf(dom.publicUrl)}</a>` : hostOf(d.publicUrl)}
        </dd>
        ${
          dom.domain
            ? html`<dt>Custom domain</dt>
                <dd><code>${dom.domain}</code></dd>`
            : ''
        }
        ${
          dom.defaultAddress
            ? html`<dt>Site address</dt>
                <dd>
                  ${hostOf(dom.defaultAddress)} <span class="admin-muted">(always works)</span>
                </dd>`
            : ''
        }
        ${
          dom.checkedAt
            ? html`<dt>Last checked</dt>
                <dd>${time(dom.checkedAt)}</dd>`
            : ''
        }
      </dl>
      <p>${domainStatusText(dom)}</p>
    </section>
    ${
      dom.records.length > 0
        ? html`<section class="admin-card" aria-labelledby="dns-h">
            <h2 id="dns-h">DNS records</h2>
            <p>
              ${
                dom.status === 'live'
                  ? 'All in place. Keep these records: removing them takes the domain offline.'
                  : 'Add each record at your DNS provider (where you bought the domain, or where its DNS is hosted), exactly as shown. Click a name or value to select it for copying.'
              }
            </p>
            ${dnsTable(dom)}
            <p class="admin-hint">
              Propagation usually takes minutes, sometimes a few hours. The provider checks every
              few minutes and switches the site over by itself; reload this page to see the latest.
            </p>
          </section>`
        : ''
    }
    ${
      dom.available
        ? html`<form
            class="admin-card admin-form"
            method="post"
            action="/admin/domain"
            aria-labelledby="domain-set-h"
          >
            ${csrfField(d.csrf)}
            <h2 id="domain-set-h">${dom.domain ? 'Change the domain' : 'Add a domain'}</h2>
            ${field({
              name: 'domain',
              label: 'Domain',
              value: dom.domain ?? '',
              placeholder: 'docs.example.com',
              required: true,
              hint: 'A domain or subdomain you own, without https://. A subdomain such as docs.example.com is easiest: it needs a CNAME record.',
            })}
            <div class="admin-buttons">
              <button class="admin-button" type="submit">
                ${dom.domain ? 'Change domain' : 'Add domain'}
              </button>
            </div>
            ${
              dom.domain
                ? html`<p class="admin-hint">
                    Changing it starts again with new DNS records; the site stays at its own address
                    until they are in place.
                  </p>`
                : ''
            }
          </form>`
        : html`<section class="admin-card">
            <h2>Not available for this site</h2>
            <p>${dom.unavailableReason ?? 'Ask your hosting provider.'}</p>
          </section>`
    }
    ${
      dom.domain
        ? html`<section class="admin-card" aria-labelledby="domain-remove-h">
            <h2 id="domain-remove-h">Remove the domain</h2>
            <p>
              The site goes back to
              ${dom.defaultAddress ? hostOf(dom.defaultAddress) : 'its own address'} at once. You
              can delete the DNS records afterwards.
            </p>
            ${confirmButton({
              action: '/admin/domain/remove',
              csrf: d.csrf,
              label: 'Remove domain',
              question: `Stop serving the site at ${dom.domain}?`,
            })}
          </section>`
        : ''
    }`;
}

// ---- docs source -----------------------------------------------------------

export interface SourcePageData {
  repos: Repo[];
  siteRepo: Repo | null;
  picker: PickableRepo[] | null;
  pickerError: string | null;
  mode: 'env' | 'broker' | 'stored' | 'none';
  production: boolean;
  jobs: OverviewData['jobs'];
  csrf: string;
}

export function repoForm(d: SourcePageData): Html {
  const current = d.siteRepo ?? d.repos[0] ?? null;
  const refs = current?.releaseRefs.join(', ') ?? 'main';
  const docsPath = current?.docsPath ?? '.';
  const lockRefs = declaredSet(current).has('releaseRefs');
  const common = html`<div class="admin-form-row">
      ${field({ name: 'releaseRefs', label: 'Release branches and tags', value: refs, hint: lockRefs ? html`${REPO_SET} (<code>site.releaseRefs</code>) for this repository and folder; change it there.` : 'Comma-separated; * matches anything, e.g. main, v*. Each push to one of these builds and publishes.', required: true, disabled: lockRefs })}${field({ name: 'docsPath', label: 'Docs folder', value: docsPath, hint: 'Where opend.config.yaml is, relative to the repository root.', required: true })}
    </div>
    <label class="admin-choice"
      ><input type="checkbox" name="build" value="1" checked /> Build now</label
    >`;
  if (d.picker) {
    if (d.picker.length === 0)
      return html`<p class="admin-empty">
        The GitHub App cannot see any repository yet. Install it on your docs repository on the
        <a href="/admin/github">GitHub</a> page.
      </p>`;
    return html`<form class="admin-form" method="post" action="/admin/source">
      ${csrfField(d.csrf)}<input type="hidden" name="from" value="github" />
      <div class="admin-field">
        <label for="f-repo">Repository</label
        ><select id="f-repo" name="repo" required>
          ${d.picker.map(
            (r) =>
              html`<option
                value="${r.fullName}"
                ${raw(current?.fullName.toLowerCase() === r.fullName.toLowerCase() ? ' selected' : '')}
              >
                ${r.fullName}${r.private ? ' (private)' : ''}
              </option>`,
          )}
        </select>
        <p class="admin-hint">Repositories the GitHub App is installed on.</p>
      </div>
      ${common}
      <div class="admin-buttons">
        <button class="admin-button" type="submit">Use this repository</button>
      </div>
    </form>`;
  }
  return html`<form class="admin-form" method="post" action="/admin/source">
    ${csrfField(d.csrf)}<input type="hidden" name="from" value="url" />
    <div class="admin-form-row">
      ${field({ name: 'fullName', label: 'Name', value: current?.fullName ?? '', placeholder: 'acme/docs', hint: 'owner/name, as on GitHub.', required: true })}${field({ name: 'sourceUrl', label: 'Clone URL', type: d.production ? 'url' : 'text', value: current?.sourceUrl ?? '', placeholder: 'https://github.com/acme/docs.git', hint: d.mode === 'none' ? 'A public https:// repository. Connect GitHub for private ones.' : 'An https:// clone URL.', required: true })}
    </div>
    ${d.mode === 'env' ? html`<div class="admin-form-row">${field({ name: 'installationId', label: 'GitHub App installation id', value: current?.installationId ? String(current.installationId) : '', hint: 'The number at the end of the installation’s settings URL. Leave empty for public repositories.' })}</div>` : ''}
    ${common}
    <div class="admin-buttons">
      <button class="admin-button" type="submit">Save repository</button>
    </div>
  </form>`;
}

export function sourcePage(d: SourcePageData): Html {
  const registered = d.repos.length
    ? html`<div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Publishes</th>
              <th scope="col">Docs folder</th>
              <th scope="col"><span class="opend-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${d.repos.map(
              (r) =>
                html`<tr>
                  <td>
                    <code>${r.fullName}</code
                    >${d.siteRepo?.id === r.id ? html` ${badge('site', 'ok')}` : ''}<br /><span
                      class="admin-muted"
                      >${r.sourceUrl}</span
                    >${r.installationId ? html`<br /><span class="admin-muted">installation ${r.installationId}</span>` : ''}
                  </td>
                  <td>${r.releaseRefs.map((ref) => html`<code>${ref}</code> `)}</td>
                  <td><code>${r.docsPath}</code></td>
                  <td class="admin-actions">
                    ${postButton({ action: '/admin/source/rebuild', csrf: d.csrf, label: 'Rebuild now', fields: { repoId: r.id }, style: 'primary' })}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="admin-empty">No repository registered yet.</p>`;
  return html`${head('Site', 'Docs source', 'The repository the documentation is built from, which branches and tags publish, and builds.')}
    ${d.pickerError ? flashBox({ kind: 'error', message: d.pickerError }) : ''}
    <section class="admin-card" aria-labelledby="repos-h">
      <h2 id="repos-h">Registered</h2>
      ${registered}
    </section>
    <section class="admin-card" aria-labelledby="pick-h">
      <h2 id="pick-h">
        ${d.repos.length ? 'Change the docs repository' : 'Choose the docs repository'}
      </h2>
      <p>
        ${d.picker ? 'Pick a repository the GitHub App can access.' : d.mode === 'none' ? html`Give a public repository’s clone URL, or <a href="/admin/github">connect GitHub</a> to pick a private one.` : 'Give the repository’s clone URL.'}
      </p>
      ${repoForm(d)}
    </section>
    <section class="admin-card" aria-labelledby="jobs-h">
      <h2 id="jobs-h">Builds</h2>
      ${buildsTable(d.jobs)}
    </section>`;
}

// ---- people ----------------------------------------------------------------

export interface PeoplePageData {
  orgs: (Org & { readers: number })[];
  readers: (Reader & { orgSlug: string })[];
  attributes: { product: string[]; feature: string[] };
  me: number;
  csrf: string;
}

function entitlementsForm(d: PeoplePageData, org: Org | null): Html {
  const prefix = org ? `org-${org.slug}` : 'org-new';
  return html`${choices({ legend: 'Products', prefix: 'product', values: d.attributes.product, checked: org?.products ?? [] })}
    ${choices({ legend: 'Features', prefix: 'feature', values: d.attributes.feature, checked: org?.features ?? [] })}
    <div class="admin-form-row">
      <div class="admin-field">
        <label for="${prefix}-version">Release version</label
        ><input
          id="${prefix}-version"
          name="version"
          type="text"
          value="${org?.version ?? ''}"
          placeholder="2.1"
          autocomplete="off"
        />
        <p class="admin-hint">
          The release line they read. Empty: no entitlements yet (they see nothing on a private
          site).
        </p>
      </div>
    </div>`;
}

export function peoplePage(d: PeoplePageData): Html {
  const orgs = d.orgs.length
    ? d.orgs.map(
        (o) =>
          html`<details class="admin-details">
            <summary>
              ${o.name}
              <code>${o.slug}</code>
              ${o.version ? badge(`${[...o.products, ...o.features].join(', ') || 'ungated'} · ${o.version}`, 'ok') : badge('no entitlements', 'warn')}
              <span class="admin-muted">${o.readers} reader(s)</span>
            </summary>
            <div>
              <form class="admin-form" method="post" action="/admin/people/orgs">
                ${csrfField(d.csrf)}<input type="hidden" name="slug" value="${o.slug}" />
                <div class="admin-form-row">
                  <div class="admin-field">
                    <label for="org-${o.slug}-name">Name</label
                    ><input
                      id="org-${o.slug}-name"
                      name="name"
                      type="text"
                      value="${o.name}"
                      required
                      autocomplete="off"
                    />
                  </div>
                </div>
                ${entitlementsForm(d, o)}
                <div class="admin-buttons">
                  <button class="admin-button" type="submit">Save ${o.name}</button
                  >${confirmButton({ action: '/admin/people/orgs/delete', csrf: d.csrf, label: 'Delete org', question: `Delete ${o.name} and its ${o.readers} reader(s)?`, fields: { slug: o.slug } })}
                </div>
              </form>
            </div>
          </details>`,
      )
    : html`<p class="admin-empty">No organizations yet.</p>`;
  const readers = d.readers.length
    ? html`<div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Reader</th>
              <th scope="col">Organization</th>
              <th scope="col">Role</th>
              <th scope="col"><span class="opend-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${d.readers.map(
              (r) =>
                html`<tr>
                  <td>
                    ${r.email}${r.name ? html`<br /><span class="admin-muted">${r.name}</span>` : ''}
                  </td>
                  <td><code>${r.orgSlug}</code></td>
                  <td>${r.staff ? badge('staff', 'ok') : badge('reader')}</td>
                  <td class="admin-actions">
                    ${
                      r.id === d.me
                        ? html`<span class="admin-muted">you</span>`
                        : html`${postButton({ action: '/admin/people/readers/staff', csrf: d.csrf, label: r.staff ? 'Remove staff' : 'Make staff', fields: { id: r.id, staff: r.staff ? '0' : '1' } })}
                          ${confirmButton({ action: '/admin/people/readers/delete', csrf: d.csrf, label: 'Remove', question: `Remove ${r.email}? They can no longer sign in.`, fields: { id: r.id } })}`
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="admin-empty">No readers yet.</p>`;
  return html`${head('Site', 'People', 'Organizations decide what their readers are entitled to; readers sign in with a verified email address. Staff readers see everything and can use this console.')}
    <section class="admin-card" aria-labelledby="readers-h">
      <h2 id="readers-h">Readers</h2>
      ${readers}
      <details class="admin-details">
        <summary>Add a reader</summary>
        <div>
          ${
            d.orgs.length
              ? html`<form class="admin-form" method="post" action="/admin/people/readers">
                  ${csrfField(d.csrf)}
                  <div class="admin-form-row">
                    ${field({ name: 'email', label: 'Email', type: 'email', required: true, hint: 'They sign in with an account whose verified email is this one.' })}${field({ name: 'name', label: 'Name (optional)' })}
                  </div>
                  <div class="admin-form-row">
                    <div class="admin-field">
                      <label for="f-orgSlug">Organization</label
                      ><select id="f-orgSlug" name="orgSlug" required>
                        ${d.orgs.map((o) => html`<option value="${o.slug}">${o.name}</option>`)}
                      </select>
                    </div>
                  </div>
                  <label class="admin-choice"
                    ><input type="checkbox" name="staff" value="1" /> Staff: sees everything and can
                    use the admin console</label
                  >
                  <div class="admin-buttons">
                    <button class="admin-button" type="submit">Add reader</button>
                  </div>
                </form>`
              : html`<p>Add an organization first.</p>`
          }
        </div>
      </details>
    </section>
    <section class="admin-card" aria-labelledby="orgs-h">
      <h2 id="orgs-h">Organizations</h2>
      ${orgs}
      <details class="admin-details">
        <summary>Add an organization</summary>
        <div>
          <form class="admin-form" method="post" action="/admin/people/orgs">
            ${csrfField(d.csrf)}
            <div class="admin-form-row">
              ${field({ name: 'slug', label: 'Short name', placeholder: 'acme', hint: 'Lowercase letters, digits and dashes.', required: true })}${field({ name: 'name', label: 'Name', placeholder: 'Acme Inc.', required: true })}
            </div>
            ${entitlementsForm(d, null)}
            <div class="admin-buttons">
              <button class="admin-button" type="submit">Add organization</button>
            </div>
          </form>
        </div>
      </details>
    </section>`;
}

// ---- sign-in ---------------------------------------------------------------

export interface SignInPageData {
  publicUrl: string;
  oidcSource: SettingSource;
  oidc: {
    issuer: string;
    clientId: string;
    displayName: string;
    icon: string;
    secretSet: boolean;
  } | null;
  githubSignIn: SettingSource;
  githubEnabled: boolean;
  githubAvailable: boolean;
  managed: boolean;
  devLoginAllowed: boolean;
  devLoginOn: boolean;
  canStoreSecrets: boolean;
  csrf: string;
}

export function signInSettingsPage(d: SignInPageData): Html {
  const env = d.oidcSource === 'env';
  const o = d.oidc;
  const providers = html`<div class="admin-provider">
      <span class="admin-provider-icon">${raw(GITHUB_ICON)}</span
      ><span class="admin-provider-text"
        ><strong>GitHub</strong
        ><span
          >${
            d.githubSignIn === 'env'
              ? 'Set by GITHUB_OAUTH_CLIENT_ID.'
              : d.managed
                ? 'Managed hosting signs readers in with GitHub through the OIDC provider below.'
                : d.githubAvailable
                  ? 'Uses the connected GitHub App’s client id. Readers are matched by verified email.'
                  : 'Connect GitHub to offer it.'
          }</span
        ></span
      >${d.githubSignIn === 'env' ? sourceBadge('env') : d.githubAvailable ? (d.githubEnabled ? badge('On', 'ok') : badge('Off')) : badge('Not available')}
    </div>
    <div class="admin-provider">
      <span class="admin-provider-icon"
        >${o?.icon === 'github' ? raw(GITHUB_ICON) : raw(KEY_ICON)}</span
      ><span class="admin-provider-text"
        ><strong>${o?.displayName || 'Company sign-in (OIDC)'}</strong
        ><span>${o ? o.issuer : 'Not configured.'}</span></span
      >${sourceBadge(d.oidcSource)}
    </div>
    ${
      d.devLoginAllowed
        ? html`<div class="admin-provider">
            <span class="admin-provider-icon">${ICONS.people}</span
            ><span class="admin-provider-text"
              ><strong>Demo readers</strong
              ><span
                >OPEND_DEV_LOGIN allows signing in as any reader, for evaluation only.</span
              ></span
            >${d.devLoginOn ? badge('On', 'warn') : badge('Off')}
          </div>`
        : ''
    }`;
  const options =
    (d.githubAvailable && d.githubSignIn !== 'env') || d.devLoginAllowed
      ? html`<form
          class="admin-card admin-form"
          method="post"
          action="/admin/sign-in/options"
          aria-labelledby="opt-h"
        >
          ${csrfField(d.csrf)}
          <h2 id="opt-h">Options</h2>
          ${d.githubAvailable && d.githubSignIn !== 'env' ? html`<input type="hidden" name="githubShown" value="1" /><label class="admin-choice"><input type="checkbox" name="github" value="1" ${raw(d.githubEnabled ? ' checked' : '')} /> Offer “Sign in with GitHub”</label>` : ''}
          ${d.devLoginAllowed ? html`<label class="admin-choice"><input type="checkbox" name="devLogin" value="1" ${raw(d.devLoginOn ? ' checked' : '')} /> Demo readers on the sign-in page</label>` : ''}
          <div class="admin-buttons">
            <button class="admin-button" type="submit">Save options</button>
          </div>
        </form>`
      : html``;
  const oidcForm = html`<form
      class="admin-card admin-form"
      method="post"
      action="/admin/sign-in/oidc"
      aria-labelledby="oidc-h"
    >
      ${csrfField(d.csrf)}
      <div class="admin-card-head">
        <h2 id="oidc-h">Company sign-in (OIDC)</h2>
        ${sourceBadge(d.oidcSource)}
      </div>
      <p class="admin-hint">
        ${env ? 'Set by OIDC_ISSUER and related variables. Remove them to edit it here.' : html`Register a client with your identity provider with the redirect URI <code>${d.publicUrl}/auth/callback</code>, then enter its details.`}
      </p>
      ${!d.canStoreSecrets && !env ? flashBox({ kind: 'warn', message: 'Secrets cannot be stored: set OPEND_SECRET_KEY or SESSION_SECRET.' }) : ''}
      <div class="admin-form-row">
        ${field({ name: 'issuer', label: 'Issuer URL', type: 'url', value: o?.issuer ?? '', placeholder: 'https://login.example.com', required: true, disabled: env })}${field({ name: 'clientId', label: 'Client id', value: o?.clientId ?? '', required: true, disabled: env })}
      </div>
      <div class="admin-form-row">
        ${field({ name: 'clientSecret', label: 'Client secret', type: 'password', autocomplete: 'new-password', placeholder: o?.secretSet ? 'Set — leave empty to keep it' : '', hint: o?.secretSet ? 'Stored encrypted; never shown again. Type a new one to replace it.' : 'Stored encrypted; never shown again.', required: !o?.secretSet, disabled: env })}${field({ name: 'displayName', label: 'Button label', value: o?.displayName ?? '', placeholder: 'Acme SSO', hint: 'Shown as “Sign in with …”.', disabled: env })}
      </div>
      <div class="admin-form-row">
        <div class="admin-field">
          <label for="f-icon">Button icon</label
          ><select id="f-icon" name="icon" ${raw(env ? ' disabled' : '')}>
            <option value="key" ${raw(o?.icon !== 'github' ? ' selected' : '')}>Key</option>
            <option value="github" ${raw(o?.icon === 'github' ? ' selected' : '')}>GitHub</option>
          </select>
        </div>
      </div>
      ${env ? '' : html`<div class="admin-buttons"><button class="admin-button" type="submit">Save OIDC settings</button></div>`}
    </form>
    ${!env && d.oidcSource === 'console' ? html`<div class="admin-buttons">${confirmButton({ action: '/admin/sign-in/oidc/delete', csrf: d.csrf, label: 'Remove company sign-in', question: 'Readers who sign in this way will have to use another provider.' })}</div>` : ''}`;
  return html`${head('Settings', 'Sign-in', 'How readers sign in. Every provider matches a registered reader by verified email address.')}
    <section class="admin-card" aria-labelledby="prov-h">
      <h2 id="prov-h">Providers</h2>
      ${providers}
    </section>
    ${options}${oidcForm}`;
}

// ---- GitHub ----------------------------------------------------------------

export interface GitHubPageData {
  mode: 'env' | 'broker' | 'stored' | 'none';
  /** Managed hosting: the docs-repository picker, from the broker's list. */
  source?: SourcePageData | null;
  app: {
    name: string;
    slug: string;
    appId: string;
    owner: string | null;
    ownerIsOrg: boolean;
    htmlUrl: string;
    webUrl: string;
  } | null;
  installation: { id: number; account: string | null } | null;
  installUrl: string | null;
  repos: PickableRepo[] | null;
  reposError: string | null;
  callbacks: string[];
  defaultName: string;
  webhook: SettingSource;
  editorUrl: string | null;
  csrf: string;
}

export function githubPage(d: GitHubPageData): Html {
  const intro = head(
    'Settings',
    'GitHub',
    'Connect GitHub to build private repositories, publish on every push, sign readers in with GitHub and run the web editor.',
  );
  const repoList = d.repos
    ? d.repos.length
      ? html`<ul>
            ${d.repos.map((r) => html`<li><code>${r.fullName}</code>${r.private ? ' (private)' : ''}</li>`)}
          </ul>
          ${d.source?.picker?.length ? '' : html`<p><a class="admin-button is-secondary" href="/admin/source">Choose the docs repository</a></p>`}`
      : html`<p class="admin-empty">
          No repositories yet: install the app on your docs repository.
        </p>`
    : '';
  if (d.mode === 'broker')
    return html`${intro}
      <section class="admin-card" aria-labelledby="gh-h">
        <div class="admin-card-head">
          <h2 id="gh-h">Managed by your hosting provider</h2>
          ${badge('Connected', 'ok')}
        </div>
        <p>
          Your hosting provider’s GitHub App builds your docs and runs the editor. Install it on the
          repositories this site may use.
        </p>
        ${d.installUrl ? html`<p><a class="admin-button is-large" href="${d.installUrl}">${raw(GITHUB_ICON)}Connect GitHub</a></p>` : ''}
        ${d.reposError ? flashBox({ kind: 'error', message: d.reposError }) : ''}
        <h3>Repositories this site can use</h3>
        ${repoList}
      </section>
      ${
        d.source?.picker?.length
          ? html`<section class="admin-card" aria-labelledby="pick-h">
              <h2 id="pick-h">Choose the docs repository</h2>
              ${repoForm(d.source)}
            </section>`
          : ''
      }`;
  if (d.mode === 'env')
    return html`${intro}
      <section class="admin-card" aria-labelledby="gh-h">
        <div class="admin-card-head">
          <h2 id="gh-h">GitHub App from the environment</h2>
          ${sourceBadge('env')}
        </div>
        <p>
          GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are set, so this site uses that app. Register
          repositories with their installation id on the
          <a href="/admin/source">Docs source</a> page. Remove the variables to connect an app here
          instead.
        </p>
        <dl class="admin-facts">
          <dt>Webhook secret</dt>
          <dd>${sourceBadge(d.webhook)}</dd>
        </dl>
      </section>`;
  if (d.mode === 'stored' && d.app) {
    const installLink = `${d.app.webUrl}/apps/${encodeURIComponent(d.app.slug)}/installations/new`;
    return html`${intro}
      <section class="admin-card" aria-labelledby="gh-h">
        <div class="admin-card-head">
          <h2 id="gh-h">Connected</h2>
          ${badge('Connected', 'ok')}
        </div>
        <ol class="admin-steps">
          <li class="is-done">
            <strong>Create the GitHub App</strong>
            <p>${d.app.name || d.app.slug}${d.app.owner ? html`, owned by ${d.app.owner}` : ''}.</p>
          </li>
          <li class="${d.installation ? 'is-done' : ''}">
            <strong>Install it on your docs repository</strong>
            <p>
              ${d.installation ? html`Installed${d.installation.account ? html` on ${d.installation.account}` : ''} (installation ${d.installation.id}).` : 'Not installed yet.'}
            </p>
          </li>
          <li>
            <strong>Choose the docs repository</strong>
            <p><a href="/admin/source">Docs source</a></p>
          </li>
        </ol>
        <dl class="admin-facts">
          <dt>App</dt>
          <dd>
            ${d.app.htmlUrl ? html`<a href="${d.app.htmlUrl}">${d.app.name || d.app.slug}</a>` : d.app.slug}
            (id ${d.app.appId})
          </dd>
          <dt>Email permission</dt>
          <dd>
            GitHub sign-in reads each person’s verified email. GitHub doesn’t let a new app ask for
            that, so add it once:
            <a
              href="${d.app.webUrl}/${d.app.ownerIsOrg && d.app.owner ? html`organizations/${d.app.owner}/` : ''}settings/apps/${d.app.slug}/permissions"
              >open the app’s permissions</a
            >, set <strong>Account permissions → Email addresses</strong> to <em>Read-only</em> and
            save. Until then, sign-in uses the public email on a person’s GitHub profile.
          </dd>
          <dt>Webhook</dt>
          <dd>${sourceBadge(d.webhook)}</dd>
          <dt>Sign-in callbacks</dt>
          <dd>
            ${d.callbacks.map((c) => html`<code>${c}</code><br />`)}<span class="admin-muted"
              >Adding the editor later? Add its callback URL in the app’s settings on GitHub.</span
            >
          </dd>
        </dl>
        <p>
          <a class="admin-button${d.installation ? ' is-secondary' : ''}" href="${installLink}"
            >${raw(GITHUB_ICON)}${d.installation ? 'Install on more repositories' : 'Install the app'}</a
          >
        </p>
        ${d.reposError ? flashBox({ kind: 'error', message: d.reposError }) : ''}
        ${
          d.installation
            ? html`<h3>Repositories the app can access</h3>
                ${repoList}`
            : ''
        }
      </section>
      <section class="admin-card" aria-labelledby="disc-h">
        <h2 id="disc-h">Disconnect</h2>
        <p>
          Removes the app’s credentials from this site: builds of private repositories, GitHub
          sign-in and the editor stop working. The app stays on GitHub until you delete it there.
        </p>
        ${confirmButton({ action: '/admin/github/disconnect', csrf: d.csrf, label: 'Disconnect GitHub', question: 'Remove the GitHub App’s credentials from this site?' })}
      </section>`;
  }
  return html`${intro}
    <section class="admin-card" aria-labelledby="gh-h">
      <div class="admin-card-head">
        <h2 id="gh-h">Connect GitHub</h2>
        ${badge('Not connected')}
      </div>
      <ol class="admin-steps">
        <li>
          <strong>Create a GitHub App for this site</strong>
          <p>GitHub shows you the app with every setting filled in; you only confirm its name.</p>
        </li>
        <li>
          <strong>Install it on your docs repository</strong>
          <p>GitHub then sends you back here.</p>
        </li>
        <li>
          <strong>Choose the docs repository</strong>
          <p>Builds start right away.</p>
        </li>
      </ol>
      <form class="admin-form" method="get" action="/admin/github/connect">
        <div class="admin-form-row">
          ${field({ name: 'name', label: 'App name', value: d.defaultName, hint: 'Must be unique on GitHub; at most 34 characters.', required: true })}${field({ name: 'owner', label: 'Organization (optional)', placeholder: 'acme', hint: 'Create the app under this GitHub organization instead of your own account. You must be an owner.' })}
        </div>
        <div class="admin-buttons">
          <button class="admin-button is-large" type="submit">
            ${raw(GITHUB_ICON)}Connect GitHub
          </button>
        </div>
      </form>
      <details class="admin-details">
        <summary>What the app is allowed to do</summary>
        <div>
          <p>
            Contents and pull requests: read and write (the web editor commits and opens pull
            requests). Commit statuses: read and write (build results). Administration and checks:
            read (branch protection). Email addresses: read (sign-in by verified email). It receives
            push events at
            <code
              >${d.callbacks[0]?.replace('/auth/github/callback', '/webhooks/github') ?? ''}</code
            >.
          </p>
          <p>Sign-in callbacks: ${d.callbacks.map((c) => html`<code>${c}</code> `)}</p>
        </div>
      </details>
    </section>`;
}

export interface ConnectPageData {
  action: string;
  manifest: string;
  name: string;
  owner: string | null;
}

/** "Continue to GitHub": posts the manifest with a visible button, so no script is needed. */
export function connectPage(d: ConnectPageData): Html {
  return html`${head('Settings', 'Create the GitHub App', html`GitHub will show the new app <strong>${d.name}</strong>${d.owner ? html` for <strong>${d.owner}</strong>` : ''} with every setting filled in. Check the name and press <em>Create GitHub App</em>; GitHub then brings you back here.`)}
    <section class="admin-card" aria-labelledby="go-h">
      <h2 id="go-h">Continue on GitHub</h2>
      <ol class="admin-steps">
        <li>
          <strong>Create the app</strong>
          <p>
            On GitHub. You may need to sign in${d.owner ? ' as an owner of the organization' : ''}.
          </p>
        </li>
        <li>
          <strong>Install it</strong>
          <p>GitHub asks which repositories the app may use: choose your docs repository.</p>
        </li>
        <li>
          <strong>Back here</strong>
          <p>Pick the docs repository and the first build starts.</p>
        </li>
      </ol>
      <form method="post" action="${d.action}">
        <input type="hidden" name="manifest" value="${d.manifest}" />
        <div class="admin-buttons">
          <button class="admin-button is-large" type="submit">
            ${raw(GITHUB_ICON)}Continue to GitHub</button
          ><a class="admin-button is-secondary" href="/admin/github">Cancel</a>
        </div>
      </form>
    </section>`;
}

// ---- editor ----------------------------------------------------------------

export interface EditorPageData {
  urlSource: SettingSource;
  url: string;
  editLinks: boolean;
  sourceLinks: boolean;
  sourceLinksEnv: boolean;
  users: EditorUser[];
  github: 'env' | 'broker' | 'stored' | 'none';
  publicUrl: string;
  csrf: string;
}

export function editorPage(d: EditorPageData): Html {
  const users = d.users.length
    ? html`<div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Author</th>
              <th scope="col">GitHub</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="opend-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${d.users.map(
              (u) =>
                html`<tr>
                  <td>
                    ${u.email}${u.name ? html`<br /><span class="admin-muted">${u.name}</span>` : ''}
                  </td>
                  <td>${u.githubLogin ? html`<code>@${u.githubLogin}</code>` : '—'}</td>
                  <td>${u.disabled ? badge('disabled', 'warn') : badge('active', 'ok')}</td>
                  <td class="admin-actions">
                    ${postButton({ action: '/admin/editor/users/disable', csrf: d.csrf, label: u.disabled ? 'Enable' : 'Disable', fields: { email: u.email, disabled: u.disabled ? '0' : '1' } })}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="admin-empty">
        No authors yet. Developers with write access to the docs repository get an account the first
        time they sign in with GitHub.
      </p>`;
  const env = d.urlSource === 'env';
  return html`${head('Settings', 'Editor', 'The web editor lets authors change the docs in the browser: they save to a branch and publish through a pull request.')}
    <form class="admin-card admin-form" method="post" action="/admin/editor" aria-labelledby="ed-h">
      ${csrfField(d.csrf)}
      <div class="admin-card-head">
        <h2 id="ed-h">Editor service</h2>
        ${sourceBadge(d.urlSource)}
      </div>
      <p class="admin-hint">
        The editor runs as its own service on its own host, with the same database. Give it
        <code>DATABASE_URL</code>, <code>SESSION_SECRET</code> (this site’s value),
        <code>EDITOR_PUBLIC_URL</code> and <code>PUBLIC_URL</code> (<code>${d.publicUrl}</code>); it
        uses the GitHub connection from this
        console.${d.github === 'none' ? ' Connect GitHub first: the editor commits through the GitHub App.' : ''}
      </p>
      <div class="admin-form-row">
        ${field({ name: 'url', label: 'Editor address', type: 'url', value: d.url, placeholder: 'https://edit.docs.example.com', hint: env ? 'Set by EDITOR_PUBLIC_URL.' : 'Where authors reach the editor. Must not be this site’s host.', disabled: env })}
      </div>
      <label class="admin-choice"
        ><input type="checkbox" name="editLinks" value="1" ${raw(d.editLinks ? ' checked' : '')} />
        “Edit this page” on topic pages for signed-in staff</label
      >
      <label class="admin-choice"
        ><input
          type="checkbox"
          name="sourceLinks"
          value="1"
          ${raw(d.sourceLinks ? ' checked' : '')}${raw(d.sourceLinksEnv ? ' disabled' : '')}
        />
        “View source on GitHub” for everyone (only for public repositories)</label
      >
      <div class="admin-buttons">
        <button class="admin-button" type="submit">Save editor settings</button>
      </div>
    </form>
    <section class="admin-card" aria-labelledby="au-h">
      <h2 id="au-h">Authors</h2>
      <p>
        Authors without access to the repository on GitHub sign in to the editor with company
        sign-in; add them here first.
      </p>
      ${users}
      <details class="admin-details">
        <summary>Add an author</summary>
        <div>
          <form class="admin-form" method="post" action="/admin/editor/users">
            ${csrfField(d.csrf)}
            <div class="admin-form-row">
              ${field({ name: 'email', label: 'Email', type: 'email', required: true })}${field({ name: 'name', label: 'Name', hint: 'Used as the commit author.' })}${field({ name: 'github', label: 'GitHub login (optional)', placeholder: 'octocat' })}
            </div>
            <div class="admin-buttons">
              <button class="admin-button" type="submit">Add author</button>
            </div>
          </form>
        </div>
      </details>
    </section>`;
}

// ---- appearance ------------------------------------------------------------

export interface AppearancePageData {
  /** The theme the form shows: the stored one, or the defaults. */
  theme: SiteTheme;
  themeStored: boolean;
  /** Whether the published release has its own theme stylesheet. */
  repoTheme: boolean;
  /** The PDF template in force: the stored one, or the repository's. */
  pdf: PdfTemplate;
  pdfStored: boolean;
  /** Whether the published release sets `pdf` in opend.config.yaml. */
  repoPdf: boolean;
  /** PDFs to check the result with, as this staff reader sees them. */
  publications: { title: string; href: string }[];
  csrf: string;
}

const checkedIf = (on: boolean) => raw(on ? ' checked' : '');

function select(o: {
  name: string;
  label: string;
  value: string;
  options: [string, string][];
  hint?: string;
}): Html {
  const id = `f-${o.name}`;
  return html`<div class="admin-field">
    <label for="${id}">${o.label}</label
    ><select id="${id}" name="${o.name}" ${o.hint ? html` aria-describedby="${id}-hint"` : ''}>
      ${o.options.map(
        ([v, label]) =>
          html`<option value="${v}" ${raw(v === o.value ? ' selected' : '')}>${label}</option>`,
      )}
    </select>
    ${o.hint ? html`<p class="admin-hint" id="${id}-hint">${o.hint}</p>` : ''}
  </div>`;
}

/** Radio buttons as pills. */
function pills(o: {
  legend: string;
  name: string;
  value: string;
  options: [string, string][];
}): Html {
  return html`<fieldset class="admin-fieldset">
    <legend class="admin-legend">${o.legend}</legend>
    <div class="admin-choices">
      ${o.options.map(
        ([v, label]) =>
          html`<label class="admin-choice"
            ><input
              type="radio"
              name="${o.name}"
              value="${v}"
              ${checkedIf(v === o.value)}
            />${label}</label
          >`,
      )}
    </div>
  </fieldset>`;
}

function textarea(o: { name: string; label: string; value: string; hint: string | Html }): Html {
  const id = `f-${o.name}`;
  return html`<div class="admin-field">
    <label for="${id}">${o.label}</label
    ><textarea
      id="${id}"
      name="${o.name}"
      maxlength="${MAX_CUSTOM_CSS}"
      spellcheck="false"
      aria-describedby="${id}-hint"
    >
${o.value}</textarea>
    <p class="admin-hint" id="${id}-hint">${o.hint}</p>
  </div>`;
}

const labels = <T extends Record<string, { label: string }>>(record: T): [string, string][] =>
  Object.entries(record).map(([k, v]) => [k, v.label]);

export function appearancePage(d: AppearancePageData): Html {
  const t = d.theme;
  const p = d.pdf;
  const themeSource = d.themeStored
    ? badge('Set here', 'ok')
    : d.repoTheme
      ? badge('Repository theme', 'info')
      : badge('Default', 'muted');
  const pdfSource = d.pdfStored
    ? badge('Set here', 'ok')
    : d.repoPdf
      ? badge('opend.config.yaml', 'info')
      : badge('Default', 'muted');
  const previews = d.publications.length
    ? html`<ul class="admin-preview-links">
        ${d.publications.map((pub) => html`<li><a href="${pub.href}">${pub.title} (PDF)</a></li>`)}
      </ul>`
    : html`<p class="admin-hint">The published release has no publications to print.</p>`;
  return html`${head('Site', 'Appearance', 'Choose how the docs site, the help panel and PDFs look. Changes apply to every page at once, with no rebuild.')}
    <form
      class="admin-card admin-form"
      method="post"
      action="/admin/appearance/theme"
      aria-labelledby="theme-h"
    >
      ${csrfField(d.csrf)}
      <div class="admin-card-head">
        <h2 id="theme-h">Site theme</h2>
        ${themeSource}
      </div>
      <p class="admin-hint">
        The theme loads after the built-in styles and after the repository’s own theme, so what you
        choose here
        wins.${d.repoTheme ? ' Keep the preset on Default to use the repository’s colours.' : ''}
      </p>
      <fieldset class="admin-fieldset">
        <legend class="admin-legend">Colour preset</legend>
        <div class="admin-options admin-presets">
          ${Object.entries(THEME_PRESETS).map(
            ([id, preset]) =>
              html`<label class="admin-option"
                ><input
                  type="radio"
                  name="preset"
                  value="${id}"
                  ${checkedIf(t.preset === id)}
                /><span class="admin-swatch admin-swatch-${id}" aria-hidden="true"
                  ><i></i><i></i></span
                ><span
                  ><strong>${preset.label}</strong><span>${preset.description}</span></span
                ></label
              >`,
          )}
        </div>
      </fieldset>
      <div class="admin-form-row">
        <div class="admin-field">
          <label class="admin-choice"
            ><input type="checkbox" name="customAccent" value="1" ${checkedIf(Boolean(t.accent))} />
            Custom accent colour</label
          >
          <label for="f-accent">Accent, light scheme</label>
          <input id="f-accent" name="accent" type="color" value="${t.accent ?? '#187f65'}" />
        </div>
        <div class="admin-field">
          <label class="admin-choice"
            ><input
              type="checkbox"
              name="customAccentDark"
              value="1"
              ${checkedIf(Boolean(t.accentDark))}
            />
            Custom dark-scheme accent</label
          >
          <label for="f-accentDark">Accent, dark scheme</label>
          <input
            id="f-accentDark"
            name="accentDark"
            type="color"
            value="${t.accentDark ?? '#3fbf98'}"
          />
          <p class="admin-hint">Left unticked, a lighter tint of the light accent is used.</p>
        </div>
      </div>
      <p class="admin-hint">
        Links, buttons and highlights use the accent. It needs at least 3:1 contrast against the
        page background of its scheme (4.5:1 reads best); the console refuses colours that are too
        faint.
      </p>
      <div class="admin-form-row">
        ${select({ name: 'font', label: 'Body font', value: t.font, options: labels(THEME_FONTS), hint: 'Fonts installed on the reader’s device; no web fonts are loaded.' })}
        ${select({ name: 'headingFont', label: 'Heading font', value: t.headingFont, options: labels(THEME_FONTS) })}
      </div>
      ${pills({ legend: 'Corners', name: 'radius', value: t.radius, options: labels(THEME_RADII) })}
      ${pills({ legend: 'Reading width', name: 'width', value: t.width, options: labels(THEME_WIDTHS) })}
      ${pills({ legend: 'Colour scheme', name: 'colorScheme', value: t.colorScheme, options: Object.entries(COLOR_SCHEMES) })}
      ${textarea({ name: 'customCss', label: 'Custom CSS', value: t.customCss, hint: html`Loaded last on every page and in the help panel (and in PDFs). Override <code>--opend-*</code> properties or style classes such as <code>.site-header</code>.` })}
      <div class="admin-buttons">
        <button class="admin-button" type="submit">Save theme</button>
      </div>
    </form>
    ${d.themeStored ? html`<div class="admin-buttons admin-reset">${confirmButton({ action: '/admin/appearance/theme/reset', csrf: d.csrf, label: 'Reset the theme', question: 'Go back to the repository’s look (or OpenD’s default)?' })}</div>` : ''}

    <section class="admin-card" aria-labelledby="pdf-h">
      <div class="admin-card-head">
        <h2 id="pdf-h">PDF template</h2>
        ${pdfSource}
      </div>
      <p class="admin-hint">
        Every publication prints with this template, for every reader. Saved here, it replaces the
        <code>pdf</code> settings in opend.config.yaml. PDFs also follow the site theme, always in
        the light scheme.
      </p>
      <form class="admin-form" method="post" action="/admin/appearance/pdf/template">
        ${csrfField(d.csrf)}
        <fieldset class="admin-fieldset">
          <legend class="admin-legend">Start from a template</legend>
          <div class="admin-options admin-presets">
            ${Object.entries(PDF_TEMPLATES).map(
              ([id, tpl]) =>
                html`<label class="admin-option"
                  ><input
                    type="radio"
                    name="template"
                    value="${id}"
                    ${checkedIf(p.template === id)}
                  /><span><strong>${tpl.label}</strong><span>${tpl.description}</span></span></label
                >`,
            )}
          </div>
        </fieldset>
        <div class="admin-buttons">
          <button class="admin-button is-secondary" type="submit">Apply template</button>
          <span class="admin-hint"
            >Replaces the settings below with the template’s; custom CSS is kept.</span
          >
        </div>
      </form>
    </section>
    <form
      class="admin-card admin-form"
      method="post"
      action="/admin/appearance/pdf"
      aria-labelledby="pdfs-h"
    >
      ${csrfField(d.csrf)}
      <input type="hidden" name="template" value="${p.template}" />
      <h2 id="pdfs-h">PDF settings</h2>
      <div class="admin-form-row">
        ${select({ name: 'pageSize', label: 'Page size', value: p.pageSize, options: labels(PAGE_SIZES) })}
        ${select({ name: 'font', label: 'Font', value: p.font, options: labels(THEME_FONTS), hint: 'Default follows the site theme. Use fonts installed on the server.' })}
      </div>
      ${pills({
        legend: 'Orientation',
        name: 'orientation',
        value: p.orientation,
        options: [
          ['portrait', 'Portrait'],
          ['landscape', 'Landscape'],
        ],
      })}
      ${pills({ legend: 'Margins', name: 'margins', value: p.margins, options: labels(PDF_MARGINS) })}
      ${pills({ legend: 'Text size', name: 'fontSize', value: p.fontSize, options: labels(PDF_FONT_SIZES) })}
      <fieldset class="admin-fieldset">
        <legend class="admin-legend">Cover</legend>
        <div class="admin-options">
          ${Object.entries(PDF_COVERS).map(([id, text]) => {
            const [name, rest = ''] = text.split(': ');
            return html`<label class="admin-option"
              ><input type="radio" name="cover" value="${id}" ${checkedIf(p.cover === id)} /><span
                ><strong>${name}</strong
                ><span>${rest.charAt(0).toUpperCase() + rest.slice(1)}.</span></span
              ></label
            >`;
          })}
        </div>
      </fieldset>
      <div class="admin-form-row">
        ${field({ name: 'coverNote', label: 'Cover note', value: p.coverNote, placeholder: 'Confidential', hint: 'An extra line on the cover. Optional.' })}
      </div>
      <div class="admin-choices">
        <label class="admin-choice"
          ><input type="checkbox" name="toc" value="1" ${checkedIf(p.toc)} /> Contents</label
        >
        <label class="admin-choice"
          ><input type="checkbox" name="chapterBreaks" value="1" ${checkedIf(p.chapterBreaks)} />
          Each chapter on a new page</label
        >
        <label class="admin-choice"
          ><input type="checkbox" name="pageNumbers" value="1" ${checkedIf(p.pageNumbers)} /> Page
          numbers</label
        >
      </div>
      <div class="admin-form-row">
        ${field({ name: 'header', label: 'Running header', value: p.header, hint: html`Top of every page. <code>{title}</code>, <code>{site}</code>, <code>{release}</code> and <code>{date}</code> are filled in. Empty for none.` })}
        ${field({ name: 'footer', label: 'Running footer', value: p.footer, hint: 'Foot of every page, before the page number.' })}
      </div>
      ${textarea({ name: 'pdfCss', label: 'Print CSS', value: p.customCss, hint: html`Loaded last in every PDF. The body has the class <code>publication</code>; hooks include <code>.pub-cover</code>, <code>.pub-toc</code> and <code>.pub-chapter</code>.` })}
      <div class="admin-buttons">
        <button class="admin-button" type="submit">Save PDF settings</button>
      </div>
    </form>
    ${d.pdfStored ? html`<div class="admin-buttons admin-reset">${confirmButton({ action: '/admin/appearance/pdf/reset', csrf: d.csrf, label: 'Reset the PDF template', question: 'Go back to the repository’s pdf settings (or the Standard template)?' })}</div>` : ''}
    <section class="admin-card" aria-labelledby="see-h">
      <h2 id="see-h">Check the result</h2>
      <p class="admin-hint">
        Open the site or a PDF as you see it. PDFs are printed again after every change.
      </p>
      <ul class="admin-preview-links">
        <li><a href="/">The docs site</a></li>
      </ul>
      ${previews}
    </section>`;
}

// ---- API keys --------------------------------------------------------------

export interface ApiPageData {
  keys: ApiKey[];
  orgs: { slug: string; name: string }[];
  /** A key just created: its token is shown this once. */
  created: { name: string; token: string } | null;
  apiBase: string;
  mcpUrl: string | null;
  csrf: string;
}

const SCOPE_LABELS: Record<ApiScope, string> = {
  read: 'read',
  write: 'propose changes',
  publish: 'publish',
  builds: 'builds',
};

function audienceLabel(k: ApiKey, orgs: ApiPageData['orgs']): string {
  if (k.audience === 'staff') return 'Everything (staff view)';
  if (k.audience === 'public') return 'Public (anonymous visitors)';
  return `Org: ${orgs.find((o) => o.slug === k.orgSlug)?.name ?? k.orgSlug ?? ''}`;
}

export function apiPage(d: ApiPageData): Html {
  const now = Date.now();
  const status = (k: ApiKey) =>
    k.revokedAt
      ? badge('revoked', 'muted')
      : k.expiresAt && k.expiresAt.getTime() <= now
        ? badge('expired', 'warn')
        : badge('active', 'ok');
  const active = (k: ApiKey) => !k.revokedAt && !(k.expiresAt && k.expiresAt.getTime() <= now);
  const keys = d.keys.length
    ? html`<div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Can</th>
              <th scope="col">Reads as</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="opend-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${d.keys.map(
              (k) =>
                html`<tr>
                  <td>
                    ${k.name}<br /><code class="admin-muted">opd_${k.prefix}_…</code> <br /><span
                      class="admin-muted"
                      >by ${k.createdBy}, ${time(k.createdAt)}</span
                    >
                  </td>
                  <td>${k.scopes.map((sc) => html`${badge(SCOPE_LABELS[sc], 'info')} `)}</td>
                  <td>${audienceLabel(k, d.orgs)}</td>
                  <td>${k.lastUsedAt ? time(k.lastUsedAt) : '—'}</td>
                  <td>
                    ${status(k)}${
                      k.expiresAt && active(k)
                        ? html`<br /><span class="admin-muted">until ${time(k.expiresAt)}</span>`
                        : ''
                    }
                  </td>
                  <td class="admin-actions">
                    ${
                      active(k)
                        ? confirmButton({
                            action: '/admin/api-keys/revoke',
                            csrf: d.csrf,
                            label: 'Revoke',
                            question: `Revoke “${k.name}”? Anything using it stops working at once.`,
                            fields: { id: k.id },
                          })
                        : ''
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="admin-empty">No API keys yet.</p>`;
  const created = d.created
    ? html`<section class="admin-card admin-reveal" aria-labelledby="key-new-h">
        <h2 id="key-new-h">Copy the key for “${d.created.name}” now</h2>
        <p>It is shown only this once. Store it like a password.</p>
        <p><code class="admin-secret">${d.created.token}</code></p>
      </section>`
    : '';
  const connect = d.mcpUrl
    ? html`<section class="admin-card" aria-labelledby="mcp-h">
        <h2 id="mcp-h">Connect an AI assistant</h2>
        <p>
          AI assistants that support MCP (Model Context Protocol), such as Claude, can search and
          read these docs and propose changes as pull requests. Add a custom connector with this
          address and sign in with an OpenD account, Google, GitHub or your email: the assistant
          sees every OpenD site you read, exactly as you see it, once your email is confirmed.
        </p>
        <p><code class="admin-secret">${d.mcpUrl}</code></p>
        <p class="admin-hint">
          Each connection gets its own key in the list below, named after the person’s email. Revoke
          it to cut that assistant off from this site.
        </p>
      </section>`
    : '';
  const orgOptions = d.orgs.map((o) => html`<option value="org:${o.slug}">Org: ${o.name}</option>`);
  return html`${head('Settings', 'API & AI', html`Read and change these docs from your own tools with the REST API at <code>${d.apiBase}</code> (<a href="${d.apiBase}/openapi.json">OpenAPI description</a>). Each key reads the docs as one audience, filtered exactly as the site is.`)}
    ${created}${connect}
    <section class="admin-card" aria-labelledby="keys-h">
      <h2 id="keys-h">API keys</h2>
      ${keys}
      <details class="admin-details" ${raw(d.keys.length ? '' : ' open')}>
        <summary>Create a key</summary>
        <div>
          <form class="admin-form" method="post" action="/admin/api-keys">
            ${csrfField(d.csrf)}
            <div class="admin-form-row">
              ${field({ name: 'name', label: 'Name', required: true, placeholder: 'Support bot', hint: 'Who or what uses it. Changes it proposes are credited to this name.' })}
            </div>
            <fieldset class="admin-fieldset">
              <legend class="admin-legend">What it can do</legend>
              <div class="admin-choices">
                <label class="admin-choice"
                  ><input type="radio" name="access" value="read" checked /> Read the docs</label
                >
                <label class="admin-choice"
                  ><input type="radio" name="access" value="write" /> Read and propose changes (pull
                  requests)</label
                >
                <label class="admin-choice"
                  ><input type="radio" name="access" value="publish" /> Read, propose and publish
                  (merges when the repository’s rules allow)</label
                >
                <label class="admin-choice"
                  ><input type="checkbox" name="builds" value="1" /> See and start builds</label
                >
              </div>
            </fieldset>
            <div class="admin-form-row">
              <div class="admin-field">
                <label for="f-audience">Reads the docs as</label
                ><select id="f-audience" name="audience" aria-describedby="f-audience-hint">
                  <option value="staff">Everything (staff view)</option>
                  ${orgOptions}
                  <option value="public">Public (anonymous visitors)</option>
                </select>
                <p class="admin-hint" id="f-audience-hint">
                  An org key sees only what that org's readers see. Use the narrowest that works.
                </p>
              </div>
              <div class="admin-field">
                <label for="f-expires">Expires</label
                ><select id="f-expires" name="expires">
                  <option value="30">In 30 days</option>
                  <option value="90" selected>In 90 days</option>
                  <option value="365">In a year</option>
                  <option value="never">Never</option>
                </select>
              </div>
            </div>
            <div class="admin-buttons">
              <button class="admin-button" type="submit">Create key</button>
            </div>
          </form>
        </div>
      </details>
    </section>`;
}

// ---- first staff reader ----------------------------------------------------

export function setupForm(token: string, error?: string): string {
  return html`<p class="opend-auth-site">Admin setup</p>
    <h1>Become the first administrator</h1>
    <p>
      This one-time link makes you a staff reader: you can read everything and run the site from the
      admin console. It works once and expires soon.
    </p>
    ${error ? html`<p class="admin-flash is-error" role="alert">${error}</p>` : ''}
    <form class="admin-form" method="post" action="/admin/setup">
      <input type="hidden" name="token" value="${token}" />
      <div class="admin-field">
        <label for="f-email">Your email</label
        ><input id="f-email" name="email" type="email" required autocomplete="email" />
        <p class="admin-hint">
          Use the address you will sign in with (GitHub or company account) from now on.
        </p>
      </div>
      <div class="admin-field">
        <label for="f-name">Your name</label
        ><input id="f-name" name="name" type="text" autocomplete="name" />
      </div>
      <div class="admin-buttons">
        <button class="admin-button" type="submit">Continue to the admin console</button>
      </div>
    </form>`.value;
}
