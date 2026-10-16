import type { GitHubLogin } from '@opend/store';

/** GitHub sign-in (OAuth web flow) for developers. */
export interface GitHubOAuth {
  authorizationUrl(redirectUri: string, state: string): string;
  /** Exchanges the callback code and returns who signed in. */
  exchange(code: string, redirectUri: string): Promise<GitHubLogin>;
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
    authorizationUrl(redirectUri, state) {
      const url = new URL(`${options.webUrl}/login/oauth/authorize`);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('allow_signup', 'false');
      return url.href;
    },
    async exchange(code, redirectUri) {
      const res = await fetchImpl(`${options.webUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
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
      const primary = emails.find((e) => e.primary && e.verified);
      return {
        id: user.id,
        login: user.login,
        name: user.name || null,
        verifiedEmail: primary?.email ?? null,
      };
    },
  };
}
