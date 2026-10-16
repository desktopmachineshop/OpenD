// A minimal host app embedding OpenD help. Run it next to an OpenD server:
//
//   OPEND_URL=http://localhost:3000 OPEND_EMBED_SECRET=... node examples/embed-host/server.mjs
//
// and set OPEND_EMBED_ORIGINS=http://localhost:5173 on the OpenD server.
// The /token endpoint stands in for your backend: it signs an embed token for
// the user who is signed in to *your* app (here, picked with ?user=).

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const OPEND_URL = process.env.OPEND_URL ?? 'http://localhost:3000';
const SECRET = process.env.OPEND_EMBED_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 5173);
if (SECRET.length < 32)
  throw new Error('set OPEND_EMBED_SECRET (the same value as on the OpenD server)');

// Your app's users and the OpenD org each belongs to.
const USERS = {
  ann: { email: 'ann@acme.example', org: 'acme' },
  gus: { email: 'gus@globex.example', org: 'globex' },
};

/** HS256 JWT without dependencies; in a real app use a JWT library such as jose. */
function embedToken({ email, org }) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ email, org, aud: OPEND_URL, iat: now, exp: now + 300 })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

const page = (user) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Widget Console</title>
<style>body{font:15px system-ui;margin:0} header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #ddd}
nav a{margin-right:12px} main{padding:16px}</style></head>
<body>
<header><strong>Widget Console</strong>
  <nav><a href="#/settings/network">Network</a><a href="#/settings/sso">Single sign-on</a><a href="#/devices/7/pair">Pair device</a><a href="#/whats-new">What's new</a></nav>
  <span style="flex:1"></span><span>Signed in as ${user}</span>
  <opend-help-button label="Help for this page"></opend-help-button>
</header>
<main><h1 id="title"></h1><p>Open the help panel with the ? button; it follows the page you are on.</p></main>
<script src="${OPEND_URL}/embed/opend-help.js"></script>
<script>
  OpenDHelp.init({
    docsUrl: ${JSON.stringify(OPEND_URL)},
    app: 'console',
    getToken: () => fetch('/token').then((r) => r.text()),
  });
  // An SPA tells the widget its route on every change, like OpenV's useLocation.
  const route = () => {
    const path = location.hash.slice(1) || '/';
    document.getElementById('title').textContent = path;
    OpenDHelp.setContext({ path });
  };
  addEventListener('hashchange', route);
  route();
</script></body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const user =
    url.searchParams.get('user') ?? req.headers.cookie?.match(/user=(\w+)/)?.[1] ?? 'ann';
  if (url.pathname === '/token') {
    res.setHeader('cache-control', 'no-store');
    return res.end(embedToken(USERS[user] ?? USERS.ann));
  }
  res.setHeader('set-cookie', `user=${user}; Path=/; SameSite=Lax`);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(page(user));
}).listen(PORT, () => console.log(`host app on http://localhost:${PORT}/?user=ann (or ?user=gus)`));
