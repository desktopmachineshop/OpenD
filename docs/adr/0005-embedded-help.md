# 0005 Embedded, context-aware help

- Status: accepted
- Date: 2026-10-16

## Context

Customers want OpenD docs inside their own web apps as a help window that opens on the help for the current screen. OpenV is the model:

- `helpTopicForPath` maps routes to topics;
- a 350px slide-in `HelpSidebar` shows a summary, tips and "learn more" links into a searchable manual.

OpenV's help is compiled into its SPA, is the same for every user, and cannot be framed. OpenD has to serve it live from the docs repo, filtered per reader, inside any host app.

## Decision

**Context keys in the content.** Topics, and map topicrefs, declare host-app contexts with DITA's standard `<resourceid appname="console" appid="settings.sso"/>`.

- **Keys are dot-separated**, so they fall back to their parents.
- **`help-contexts.yaml`** maps host routes to keys per app and sets a default. Patterns support `:param`, `*` and a trailing `**`, with the most specific match winning.
- **The build indexes contexts** in the release snapshot. Map entries come first, like keys. Ambiguous keys, incomplete `resourceid`s, bad patterns and routes to undefined keys are build errors.
- **`resolveContext`** (in `@opend/filter`) tries the key, then its parents, then the default. It accepts a target only if its conditions pass for the reader and its topic is visible. **A context lookup never reveals a hidden topic: it falls back.** One key can also point to different topics per reader (`whats-new` → 1.x or 2.x notes).

**One panel renderer.** `handleEmbedRequest` in `@opend/render-html` serves the panel for both the previewer and hosted delivery: `/embed/context`, `/embed/topics/<id>.html`, `/embed/search`.

- **Panel content:** a compact topic view whose links stay in the panel, "In this section", search, and "Open in full docs".
- **Search** (`searchView`) covers only the reader's visible topics, so neither results nor snippets leak. Hosted delivery now searches with Postgres under the same rule; see [ADR 0008](0008-search.md).

**Widget and protocol.** `@opend/embed` provides:

- **`/embed/opend-help.js`:** `window.OpenDHelp` (`init`, `open`, `close`, `toggle`, `setContext`) and `<opend-help-button>`.
- **A slide-in drawer** holding an iframe. It is non-modal, so it doesn't trap focus. Escape closes it, and focus returns to where it was, even inside shadow DOM.
- **A versioned postMessage protocol.** Both sides check `event.origin` and `event.source`, and messages are sent to an explicit origin, never `*`.
- **Self-contained scripts:** they are type-checked TypeScript functions served through `toString`.

**Who the reader is.** The host app already knows its user. Its backend signs a short-lived HS256 token with the shared `OPEND_EMBED_SECRET`:

- **Claims:** email and org, audience = OpenD's `PUBLIC_URL`, lifetime at most 10 minutes.
- **Exchange:** when the frame has no session, it asks the widget for a token over postMessage and posts it to `/embed/session`. That sets a `SameSite=None; Secure; Partitioned` cookie, which exists only under that host site.
- **Entitlements still come from OpenD**, so a host app can't grant more than OpenD allows.
- **Refusals:** unknown readers and org mismatches are refused.

**Framing.**

- `/embed/*` pages send `frame-ancestors` listing only `OPEND_EMBED_ORIGINS`.
- The docs site keeps `frame-ancestors 'none'`.
- The panel runs no inline script (`script-src 'self'`).

**Native rendering.** `/api/v1/help/context|topics|search` returns the same filtered content as JSON. It takes bearer tokens, and CORS is limited to the allowed origins.

**Off by default.** Nothing under `/embed` or `/api/v1/help` exists unless both settings are set.

## Consequences

- **Previewer help lab:** authors check context help locally at `/_opend/help-lab`. It lists every app, key and route, shows what each resolves to for the preview reader, and runs the real widget.
- **Browser support:** the session relies on partitioned cookies (CHIPS). Browsers that block all third-party cookies, even partitioned ones, can't keep a panel session; host apps can use the JSON API there.
- **Images in the JSON API** use absolute docs URLs that need a docs session. Host apps that render natively and need gated images should proxy them.
- **One shared secret per deployment.** Per-tenant secrets, or host JWKS with RS256, arrive with multi-tenancy.
- **Tests:** a Playwright test drives the widget across origins in Chromium. The stage 1 leak markers also run over embed pages, contexts and search.
