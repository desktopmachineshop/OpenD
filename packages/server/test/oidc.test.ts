import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl, upsertOrg, upsertReader, setEntitlements } from '@opend/store';
import { createOidcProvider } from '../src/index.js';
import { cookiesFrom, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const CLIENT_ID = 'opend-docs';
const CLIENT_SECRET = 'client-secret';

interface PendingCode {
  nonce: string;
  challenge: string;
  identity: Record<string, unknown>;
}

/** A tiny OIDC issuer: discovery, JWKS and a token endpoint that checks PKCE. */
async function startIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (u.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(body);
          const pending = codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!pending || challenge !== pending.challenge)
            return json(400, { error: 'invalid_grant' });
          codes.delete(form.get('code') ?? '');
          const idToken = await new SignJWT({ nonce: pending.nonce, ...pending.identity })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          json(200, {
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          });
        })();
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  return {
    issuer,
    /** Plays the IdP: approves the authorization request for this identity and returns a code. */
    approve(authorizationUrl: URL, identity: Record<string, unknown>): string {
      const code = randomUUID();
      codes.set(code, {
        nonce: authorizationUrl.searchParams.get('nonce') ?? '',
        challenge: authorizationUrl.searchParams.get('code_challenge') ?? '',
        identity,
      });
      return code;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!url)('OIDC sign-in', () => {
  let issuer: Awaited<ReturnType<typeof startIssuer>>;
  let h: Harness;

  beforeAll(async () => {
    issuer = await startIssuer();
    const oidc = createOidcProvider({
      issuer: issuer.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: 'openid email',
      allowInsecure: true,
    });
    h = await startHarness(url!, { oidc, config: { devLogin: false } });
    await upsertOrg(h.db.pool, { slug: 'acme', name: 'Acme' });
    await setEntitlements(h.db.pool, 'acme', {
      products: ['widget'],
      features: [],
      version: '1.4',
    });
    await upsertReader(h.db.pool, { orgSlug: 'acme', email: 'ann@acme.example' });
  });
  afterAll(async () => {
    await h?.close();
    await issuer?.close();
  });

  /** Starts sign-in and returns the IdP URL and the pending-login cookie. */
  async function begin(returnTo = '/topics/install.html') {
    const res = await h.app.inject({
      method: 'GET',
      url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(res.statusCode).toBe(302);
    return { idp: new URL(String(res.headers.location)), cookie: cookiesFrom(res) };
  }

  const callback = (query: string, cookie: string) =>
    h.app.inject({
      method: 'GET',
      url: `/auth/callback?${query}`,
      headers: cookie ? { cookie } : {},
    });

  it('redirects to the issuer with PKCE, state and nonce', async () => {
    const { idp, cookie } = await begin();
    expect(idp.origin + idp.pathname).toBe(`${issuer.issuer}/authorize`);
    expect(idp.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(idp.searchParams.get('redirect_uri')).toBe('http://docs.test/auth/callback');
    expect(idp.searchParams.get('code_challenge_method')).toBe('S256');
    expect(idp.searchParams.get('state')).toBeTruthy();
    expect(idp.searchParams.get('nonce')).toBeTruthy();
    expect(cookie).toContain('opend_oidc=');
  });

  it('signs in a registered reader by verified email and returns to the page', async () => {
    const { idp, cookie } = await begin();
    const code = issuer.approve(idp, {
      sub: 'user-1',
      email: 'ann@acme.example',
      email_verified: true,
    });
    const res = await callback(`code=${code}&state=${idp.searchParams.get('state')}`, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/topics/install.html');
    const session = cookiesFrom(res);
    expect(session).toContain('opend_session=');
    // Signed in: the delivery routes accept the session (no release is published here).
    const page = await h.app.inject({ method: 'GET', url: '/', headers: { cookie: session } });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('No documentation site is configured yet');
  });

  it('refuses unknown and unverified accounts', async () => {
    for (const identity of [
      { sub: 'stranger', email: 'eve@evil.example', email_verified: true },
      { sub: 'user-2', email: 'ann@acme.example', email_verified: false },
    ]) {
      const { idp, cookie } = await begin();
      const code = issuer.approve(idp, identity);
      const res = await callback(`code=${code}&state=${idp.searchParams.get('state')}`, cookie);
      expect(res.statusCode).toBe(403);
      expect(res.headers['set-cookie'] ?? '').not.toContain('opend_session=');
    }
  });

  it('rejects a wrong state, a missing login cookie and a forged code', async () => {
    const { idp, cookie } = await begin();
    const code = issuer.approve(idp, {
      sub: 'user-1',
      email: 'ann@acme.example',
      email_verified: true,
    });
    expect((await callback(`code=${code}&state=wrong`, cookie)).statusCode).toBe(400);
    expect(
      (await callback(`code=${code}&state=${idp.searchParams.get('state')}`, '')).statusCode,
    ).toBe(400);
    const second = await begin();
    expect(
      (await callback(`code=forged&state=${second.idp.searchParams.get('state')}`, second.cookie))
        .statusCode,
    ).toBe(400);
  });

  it('never redirects off-site after sign-in', async () => {
    const { idp, cookie } = await begin('//evil.example/phish');
    const code = issuer.approve(idp, {
      sub: 'user-1',
      email: 'ann@acme.example',
      email_verified: true,
    });
    const res = await callback(`code=${code}&state=${idp.searchParams.get('state')}`, cookie);
    expect(res.headers.location).toBe('/');
  });

  it('has no development sign-in when it is turned off', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/auth/dev' })).statusCode).toBe(302); // falls to delivery → login
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/auth/dev',
          payload: 'readerId=1',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
