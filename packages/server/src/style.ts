/**
 * Styles for the server's own pages (sign-in, notices), on top of the docs
 * stylesheet (`DEFAULT_CSS`), so they follow the OpenD design system and any
 * customer theme: only `--opend-*` tokens, no raw colours.
 */
export const SERVER_CSS = `
body.opend-plain { min-height: 100vh; margin: 0; background: var(--opend-surface-alt); }
.opend-simple { max-width: 30rem; margin: 0 auto; padding: 64px 16px; }
.opend-card { padding: 32px; border: 1px solid var(--opend-border); border-radius: 16px; background: var(--opend-surface); box-shadow: var(--opend-shadow); }
.opend-card > h1 { margin: 0 0 8px; font-size: 26px; }
.opend-card > p { color: var(--opend-muted); }
.opend-card > :last-child { margin-bottom: 0; }
.opend-simple button { min-height: 40px; padding: 6px 16px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface); font-weight: 600; cursor: pointer; }
.opend-simple button:hover { border-color: var(--opend-accent); color: var(--opend-link); }
.opend-simple button:focus-visible { border-radius: 999px; }
.opend-auth-site { margin: 0 0 4px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--opend-link); }
.opend-auth-providers { list-style: none; margin: 24px 0 0; padding: 0; display: grid; gap: 10px; }
.opend-auth-provider { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 46px; padding: 8px 18px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius); background: var(--opend-surface); color: var(--opend-heading); font-weight: 600; text-decoration: none; }
.opend-auth-provider:hover { border-color: var(--opend-accent); background: var(--opend-accent-soft); color: var(--opend-heading); }
.opend-auth-provider svg { flex: none; fill: currentColor; }
.opend-auth-provider.is-primary { border-color: var(--opend-accent); background: var(--opend-accent); color: var(--opend-on-accent); }
.opend-auth-provider.is-primary:hover { border-color: var(--opend-link-hover); background: var(--opend-link-hover); color: var(--opend-on-accent); }
.opend-auth-demo { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--opend-border); }
.opend-auth-demo h2 { margin: 0 0 4px; font-size: 16px; }
.opend-auth-demo p { margin: 0 0 12px; color: var(--opend-muted); font-size: 14px; }
.opend-auth-demo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.opend-auth-demo form { margin: 0; }
.opend-auth-demo button { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 12px; border-radius: var(--opend-radius); text-align: left; }
.opend-auth-demo button span { overflow-wrap: anywhere; }
.opend-auth-demo small { flex: none; padding: 1px 9px; border-radius: 999px; background: var(--opend-accent-soft); color: var(--opend-link); font-size: 12px; font-weight: 600; }
.opend-auth-badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--opend-warn) 14%, var(--opend-surface)); color: var(--opend-warn); font-size: 12px; font-weight: 700; vertical-align: middle; }
.opend-auth-foot { margin: 24px 0 0; font-size: 14px; text-align: center; }
@media (max-width: 30rem) {
  .opend-simple { padding: 24px 12px; }
  .opend-card { padding: 24px 18px; }
}
`;
