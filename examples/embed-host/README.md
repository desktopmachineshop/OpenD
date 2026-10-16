# Example: a host app with embedded OpenD help

`server.mjs` is a tiny "Widget Console" that embeds context-sensitive help from an OpenD server, the way a customer's web app would.

1. Run OpenD (see the main README) with:
   ```
   OPEND_EMBED_SECRET=<32+ random characters>
   OPEND_EMBED_ORIGINS=http://localhost:5173
   ```
   Publish the starter template, and seed `ann@acme.example` (org `acme`) and `gus@globex.example` (org `globex`).
2. Start the host app with the same secret:
   ```
   OPEND_URL=http://localhost:3000 OPEND_EMBED_SECRET=<same secret> node examples/embed-host/server.mjs
   ```
3. Open http://localhost:5173/?user=ann and http://localhost:5173/?user=gus. Click **?** and move between pages: the panel follows the route through `help-contexts.yaml`, and each user sees only the help their org is entitled to.

The `/token` endpoint stands in for your backend. It signs a short-lived embed token for the user signed in to your app. The secret never reaches the browser.
