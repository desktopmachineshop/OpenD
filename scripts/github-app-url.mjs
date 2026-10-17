#!/usr/bin/env node
// Prints a link that opens GitHub's "Register new GitHub App" form pre-filled for
// OpenD: one App for reader sign-in on the docs site, the web editor (sign-in,
// commits and pull requests) and the build webhook. See docs/github-app.md.
//
//   node scripts/github-app-url.mjs <docsUrl> <editorUrl> [appName] [--org <org>]
//
// GitHub cannot take the webhook secret from the URL: set it on the form (the
// value of GITHUB_WEBHOOK_SECRET) before creating the App.

const args = process.argv.slice(2);
const orgAt = args.indexOf('--org');
const org = orgAt === -1 ? null : args.splice(orgAt, 2)[1];
const [docsArg, editorArg, nameArg] = args;

function origin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    console.error(`${label} must be a URL such as https://docs.example.com`);
    process.exit(2);
  }
  return url.origin;
}

if (!docsArg || !editorArg) {
  console.error(
    'usage: node scripts/github-app-url.mjs <docsUrl> <editorUrl> [appName] [--org <org>]',
  );
  process.exit(2);
}
const docs = origin(docsArg, 'docsUrl');
const editor = origin(editorArg, 'editorUrl');
// App names are unique on GitHub and at most 34 characters.
const name = (nameArg ?? `OpenD ${new URL(docs).hostname.split('.')[0]}`).slice(0, 34);

/** Query parameters GitHub reads on /settings/apps/new; see docs/github-app.md. */
const params = [
  ['name', name],
  ['description', 'OpenD docs: reader sign-in, web editor and build webhook'],
  ['url', docs],
  ['callback_urls[]', `${docs}/auth/github/callback`],
  ['callback_urls[]', `${editor}/auth/github/callback`],
  ['request_oauth_on_install', 'false'],
  ['public', 'false'],
  ['webhook_active', 'true'],
  ['webhook_url', `${docs}/webhooks/github`],
  ['events[]', 'push'],
  // Repository permissions.
  ['contents', 'write'],
  ['pull_requests', 'write'],
  ['administration', 'read'],
  ['checks', 'read'],
  // Write, so builds can set the opend/build commit status (the editor only reads them).
  ['statuses', 'write'],
  ['metadata', 'read'],
  // Account permission, for reader and author sign-in.
  ['email_addresses', 'read'],
];

const base = org
  ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
  : 'https://github.com/settings/apps/new';
const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
console.log(`${base}?${query}`);
