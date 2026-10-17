import { createHash, randomBytes } from 'node:crypto';
import type { GitHubLogin, GitHubUserGrant } from '@opend/store';

/** Who signed in with GitHub, with every email address GitHub has verified for them. */
export interface GitHubSignIn extends GitHubLogin {
  /** Verified addresses, the primary one first. Unverified addresses are never included. */
  verifiedEmails: string[];
  /**
   * The user access token GitHub issued. Not enumerable, so logging or
   * serialising a sign-in never includes it. Never log, render or return it.
   */
  readonly grant?: GitHubUserGrant;
}

function grantFrom(body: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}): GitHubUserGrant {
  const grant: GitHubUserGrant = { accessToken: body.access_token! };
  if (body.refresh_token) grant.refreshToken = body.refresh_token;
  if (typeof body.expires_in === 'number') grant.expiresIn = body.expires_in;
  if (typeof body.refresh_token_expires_in === 'number')
    grant.refreshTokenExpiresIn = body.refresh_token_expires_in;
  return grant;
}

/**
 * GitHub sign-in (OAuth web flow), for the editor's developers and for docs
 * readers. Works with an OAuth App or a GitHub App's own client credentials.
 * Callers protect the flow with `state`, and with PKCE (S256): GitHub checks
 * the verifier when the authorization request carried a challenge.
 */
export interface GitHubOAuth {
  authorizationUrl(redirectUri: string, state: string, codeChallenge?: string): string;
  /** Exchanges the callback code and returns who signed in. */
  exchange(code: string, redirectUri: string, codeVerifier?: string): Promise<GitHubSignIn>;
  /**
   * Trades a refresh token for a new user access token (GitHub App expiring
   * user tokens). The old access and refresh tokens stop working.
   */
  refresh(refreshToken: string): Promise<GitHubUserGrant>;
}

/**
 * Whether a client id belongs to a GitHub App (`Iv1.…`, `Iv23…`) rather than an
 * OAuth App (`Ov23…`, or 20 hex digits). Only a GitHub App's user tokens are
 * limited to the app's permissions, so only those are kept for commits.
 */
export function isGitHubAppClientId(clientId: string): boolean {
  return clientId.startsWith('Iv');
}

/** A fresh PKCE verifier and its S256 challenge. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function createGitHubOAuth(
  options: { clientId: string; clientSecret: string; webUrl: string; apiUrl?: string },
  fetchImpl: typeof fetch = fetch,
): GitHubOAuth {
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const api = async (path: string, token: string) => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  return {
    authorizationUrl(redirectUri, state, codeChallenge) {
      const url = new URL(`${options.webUrl}/login/oauth/authorize`);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      // OAuth Apps need these scopes; GitHub Apps ignore scopes and use the
      // app's permissions (Email addresses: read) instead.
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('allow_signup', 'false');
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.href;
    },
    async exchange(code, redirectUri, codeVerifier) {
      const res = await fetchImpl(`${options.webUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
      });
      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        refresh_token_expires_in?: number;
        error?: string;
      };
      if (!res.ok || !body.access_token)
        throw new Error(`GitHub token exchange failed: ${body.error ?? res.status}`);
      const user = (await api('/user', body.access_token)) as {
        id: number;
        login: string;
        name: string | null;
      };
      const emails = (await api('/user/emails', body.access_token)) as {
        email: string;
        primary: boolean;
        verified: boolean;
      }[];
      const verified = emails.filter((e) => e.verified === true);
      const primary = verified.find((e) => e.primary);
      const signIn: GitHubSignIn = {
        id: user.id,
        login: user.login,
        name: user.name || null,
        verifiedEmail: primary?.email ?? null,
        verifiedEmails: [
          ...(primary ? [primary.email] : []),
          ...verified.filter((e) => e !== primary).map((e) => e.email),
        ],
      };
      Object.defineProperty(signIn, 'grant', { value: grantFrom(body), enumerable: false });
      return signIn;
    },
    async refresh(refreshToken) {
      const res = await fetchImpl(`${options.webUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
      };
      if (!res.ok || !body.access_token)
        throw new Error(`GitHub token refresh failed: ${body.error ?? res.status}`);
      return grantFrom(body);
    },
  };
}
