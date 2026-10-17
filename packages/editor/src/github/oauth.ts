import { createHash, randomBytes } from 'node:crypto';
import type { GitHubLogin } from '@opend/store';

/** Who signed in with GitHub, with every email address GitHub has verified for them. */
export interface GitHubSignIn extends GitHubLogin {
  /** Verified addresses, the primary one first. Unverified addresses are never included. */
  verifiedEmails: string[];
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
      const body = (await res.json()) as { access_token?: string; error?: string };
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
      return {
        id: user.id,
        login: user.login,
        name: user.name || null,
        verifiedEmail: primary?.email ?? null,
        verifiedEmails: [
          ...(primary ? [primary.email] : []),
          ...verified.filter((e) => e !== primary).map((e) => e.email),
        ],
      };
    },
  };
}
