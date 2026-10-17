/**
 * Styles for the admin console, on top of the docs stylesheet (`DEFAULT_CSS`),
 * whose header, sidebar and menu it reuses. Only `--opend-*` tokens, so it
 * follows the OpenD design system in light and dark schemes.
 */
export const ADMIN_CSS = `
.opend-admin { background: var(--opend-surface-alt); }
.opend-admin .site-header { background: var(--opend-surface); }
.opend-admin .toc { background: var(--opend-surface); }
.opend-admin main { padding: 32px 40px 80px; }
.admin-page { max-width: 60rem; margin: 0 auto; }
.admin-mark { display: inline-grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: var(--opend-radius-sm); background: var(--opend-accent); color: var(--opend-on-accent); }
.admin-mark svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.admin-view-site { margin-left: auto; font-size: 14px; font-weight: 600; text-decoration: none; }
.admin-view-site:hover { text-decoration: underline; }
.opend-admin .site-header > .site-account { margin-left: 0; }
.admin-nav-label { margin: 18px 0 4px; padding: 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--opend-muted); }
.admin-nav-label:first-child { margin-top: 0; }
.opend-nav .admin-nav-link { display: flex; align-items: center; gap: 10px; }
.admin-nav-link svg { flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; opacity: 0.8; }

.admin-head { margin: 0 0 24px; }
.admin-eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--opend-link); }
.admin-head h1 { margin: 0 0 6px; }
.admin-lead { margin: 0; max-width: var(--opend-measure); font-size: 17px; color: var(--opend-muted); }

.admin-card { margin: 0 0 20px; padding: 24px; border: 1px solid var(--opend-border); border-radius: 16px; background: var(--opend-surface); box-shadow: var(--opend-shadow); }
.admin-card > h2 { margin: 0 0 6px; font-size: 19px; }
.admin-card > h2 + p { margin-top: 0; color: var(--opend-muted); }
.admin-card > :last-child { margin-bottom: 0; }
.admin-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: 0 0 12px; }
.admin-card-head h2 { margin: 0; font-size: 19px; }
.admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 16px; margin: 0 0 20px; }
.admin-grid > .admin-card { margin: 0; }
.admin-stat { display: flex; flex-direction: column; gap: 4px; }
.admin-stat-label { font-size: 13px; font-weight: 600; color: var(--opend-muted); }
.admin-stat-value { font-size: 22px; font-weight: 750; color: var(--opend-heading); letter-spacing: -0.02em; overflow-wrap: anywhere; }

.admin-facts { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: 8px 20px; margin: 0 0 16px; }
.admin-facts dt { color: var(--opend-muted); font-weight: 600; }
.admin-facts dd { margin: 0; overflow-wrap: anywhere; }

.admin-table-wrap { overflow-x: auto; margin: 0 0 12px; border: 1px solid var(--opend-border); border-radius: var(--opend-radius); }
.admin-table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.admin-table th, .admin-table td { padding: 10px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--opend-border); }
.admin-table thead th { background: var(--opend-surface-alt); color: var(--opend-heading); font-size: 13px; font-weight: 700; white-space: nowrap; }
.admin-table tbody tr:last-child > * { border-bottom: 0; }
.admin-table td.admin-actions { white-space: nowrap; text-align: right; }
.admin-table code { white-space: nowrap; }
.admin-empty { margin: 0; padding: 16px; border: 1px dashed var(--opend-border-strong); border-radius: var(--opend-radius); color: var(--opend-muted); text-align: center; }

.admin-badge { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; line-height: 1.6; white-space: nowrap; background: color-mix(in srgb, var(--opend-muted) 14%, var(--opend-surface)); color: var(--opend-muted); }
.admin-badge.is-ok { background: var(--opend-accent-soft); color: var(--opend-link); }
.admin-badge.is-warn { background: color-mix(in srgb, var(--opend-warn) 14%, var(--opend-surface)); color: var(--opend-warn); }
.admin-badge.is-danger { background: color-mix(in srgb, var(--opend-danger) 12%, var(--opend-surface)); color: var(--opend-danger); }
.admin-badge.is-info { background: color-mix(in srgb, var(--opend-info) 12%, var(--opend-surface)); color: var(--opend-info); }

.admin-flash { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 20px; padding: 12px 16px; border: 1px solid color-mix(in srgb, var(--opend-accent) 35%, var(--opend-border)); border-left: 4px solid var(--opend-accent); border-radius: var(--opend-radius-sm); background: var(--opend-accent-soft); color: var(--opend-heading); }
.admin-flash.is-error { border-color: color-mix(in srgb, var(--opend-danger) 35%, var(--opend-border)); border-left-color: var(--opend-danger); background: color-mix(in srgb, var(--opend-danger) 8%, var(--opend-surface)); }
.admin-flash.is-warn { border-color: color-mix(in srgb, var(--opend-warn) 35%, var(--opend-border)); border-left-color: var(--opend-warn); background: color-mix(in srgb, var(--opend-warn) 8%, var(--opend-surface)); }
.admin-flash p { margin: 0; }

.admin-form { display: grid; gap: 16px; margin: 0; }
.admin-form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 16px; }
.admin-field { display: grid; gap: 6px; min-width: 0; align-content: start; }
.admin-form > .admin-choice { justify-self: start; }
.admin-card.admin-form { margin: 0 0 20px; }
.admin-card > .admin-details, .admin-card > form + .admin-details { margin-top: 16px; }
.admin-field > label, .admin-legend { font-weight: 650; color: var(--opend-heading); font-size: 15px; }
.admin-hint { margin: 0; font-size: 13.5px; color: var(--opend-muted); }
.admin-field input[type="text"], .admin-field input[type="email"], .admin-field input[type="url"], .admin-field input[type="password"], .admin-field select { width: 100%; min-height: 42px; padding: 8px 12px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius); background: var(--opend-surface); box-sizing: border-box; }
.admin-field input:focus-visible, .admin-field select:focus-visible { outline: 3px solid var(--opend-focus); outline-offset: 1px; border-color: var(--opend-accent); border-radius: var(--opend-radius); }
.admin-field input:disabled, .admin-field select:disabled { opacity: 0.6; cursor: not-allowed; background: var(--opend-surface-alt); }
.admin-fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.admin-fieldset > legend { padding: 0; margin: 0 0 8px; }
.admin-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.admin-choice { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 6px 14px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface); cursor: pointer; font-size: 14.5px; }
.admin-choice:has(input:checked) { border-color: var(--opend-accent); background: var(--opend-accent-soft); color: var(--opend-link); font-weight: 600; }
.admin-choice:has(input:focus-visible) { outline: 3px solid var(--opend-focus); outline-offset: 2px; }
.admin-choice input { margin: 0; accent-color: var(--opend-accent); }
.admin-options { display: grid; gap: 10px; }
.admin-option { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius); background: var(--opend-surface); cursor: pointer; }
.admin-option:has(input:checked) { border-color: var(--opend-accent); background: var(--opend-accent-soft); }
.admin-option:has(input:focus-visible) { outline: 3px solid var(--opend-focus); outline-offset: 2px; }
.admin-option input { margin: 4px 0 0; accent-color: var(--opend-accent); }
.admin-option strong { display: block; color: var(--opend-heading); }
.admin-option span { color: var(--opend-muted); font-size: 14px; }
.admin-buttons { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.admin-inline { display: inline; margin: 0; }

.admin-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 6px 18px; border: 1px solid var(--opend-accent); border-radius: 999px; background: var(--opend-accent); color: var(--opend-on-accent); font-size: 15px; font-weight: 650; text-decoration: none; cursor: pointer; white-space: nowrap; }
.admin-button:hover { border-color: var(--opend-link-hover); background: var(--opend-link-hover); color: var(--opend-on-accent); }
.admin-button:focus-visible { border-radius: 999px; }
.admin-button svg { flex: none; fill: currentColor; }
.admin-button.is-secondary { border-color: var(--opend-border-strong); background: var(--opend-surface); color: var(--opend-heading); }
.admin-button.is-secondary:hover { border-color: var(--opend-accent); color: var(--opend-link); background: var(--opend-surface); }
.admin-button.is-danger { border-color: color-mix(in srgb, var(--opend-danger) 45%, var(--opend-border)); background: var(--opend-surface); color: var(--opend-danger); }
.admin-button.is-danger:hover { border-color: var(--opend-danger); background: color-mix(in srgb, var(--opend-danger) 8%, var(--opend-surface)); }
.admin-button.is-small { min-height: 34px; padding: 4px 12px; font-size: 13.5px; }
.admin-button.is-large { min-height: 48px; padding: 10px 24px; font-size: 16px; }

.admin-confirm { display: inline-block; position: relative; }
.admin-confirm > summary { list-style: none; }
.admin-confirm > summary::-webkit-details-marker { display: none; }
.admin-confirm[open] > summary { margin-bottom: 8px; }
.admin-confirm-panel { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius); background: var(--opend-surface); text-align: left; white-space: normal; max-width: 22rem; }
.admin-confirm-panel p { margin: 0; font-size: 14px; }

.admin-details { border: 1px solid var(--opend-border); border-radius: var(--opend-radius); background: var(--opend-surface); }
.admin-details + .admin-details { margin-top: 10px; }
.admin-details > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px; cursor: pointer; font-weight: 650; color: var(--opend-heading); border-radius: var(--opend-radius); }
.admin-details > summary:hover { background: var(--opend-hover); }
.admin-details > div { padding: 4px 16px 16px; }
.admin-diag { margin: 0; padding-left: 18px; font-size: 14px; }
.admin-diag code { white-space: normal; }

.admin-steps { list-style: none; counter-reset: step; margin: 0 0 16px; padding: 0; display: grid; gap: 12px; }
.admin-steps > li { counter-increment: step; position: relative; padding: 2px 0 2px 44px; min-height: 32px; }
.admin-steps > li::before { content: counter(step); position: absolute; left: 0; top: 0; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 999px; background: var(--opend-accent-soft); color: var(--opend-link); font-weight: 750; font-size: 14px; }
.admin-steps > li.is-done::before { content: '✓'; background: var(--opend-accent); color: var(--opend-on-accent); }
.admin-steps strong { color: var(--opend-heading); }
.admin-steps p { margin: 2px 0 0; color: var(--opend-muted); font-size: 14.5px; }

.admin-provider { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 14px 0; border-top: 1px solid var(--opend-border); }
.admin-provider:first-of-type { border-top: 0; padding-top: 0; }
.admin-provider-icon { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: var(--opend-radius); background: var(--opend-accent-soft); color: var(--opend-link); }
.admin-provider-icon svg { fill: currentColor; }
.admin-provider-icon svg.admin-stroke, .admin-mark svg.admin-stroke { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.admin-provider-text { flex: 1 1 14rem; min-width: 0; }
.admin-provider-text strong { display: block; color: var(--opend-heading); }
.admin-provider-text span { color: var(--opend-muted); font-size: 14px; }

.opend-simple .admin-button { border-color: var(--opend-accent); background: var(--opend-accent); color: var(--opend-on-accent); }
.opend-simple .admin-button:hover { border-color: var(--opend-link-hover); background: var(--opend-link-hover); color: var(--opend-on-accent); }
.admin-muted { color: var(--opend-muted); }
.admin-code { display: block; padding: 10px 12px; border: 1px solid var(--opend-border); border-radius: var(--opend-radius-sm); background: var(--opend-code-bg); font-family: var(--opend-mono); font-size: 13.5px; overflow-wrap: anywhere; }

@media (max-width: 60rem) {
  .opend-admin main { padding: 20px 16px 56px; }
  .admin-view-site { display: none; }
  .admin-card { padding: 18px 16px; border-radius: var(--opend-radius); }
  .admin-facts { grid-template-columns: 1fr; gap: 2px; }
  .admin-facts dd { margin-bottom: 8px; }
  .admin-table th, .admin-table td { padding: 9px 10px; }
  .admin-table td.admin-actions { white-space: normal; }
  .site-menu-panel .admin-nav-label { margin-top: 12px; }
}
`;
