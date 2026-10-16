import * as client from 'openid-client';

/**
 * Company sign-in for authors without GitHub. The same shape as the docs
 * server's reader provider (`@opend/server` oidc.ts), configured separately
 * (EDITOR_OIDC_*) so editor and reader sign-ins never share a client.
 */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcProvider {
  authorizationUrl(redirectUri: string, checks: OidcChecks): Promise<URL>;
  /** Exchanges the callback URL's code and validates state, nonce and the ID token. */
  exchange(callbackUrl: URL, checks: OidcChecks): Promise<OidcIdentity>;
}

export function newChecks(): OidcChecks {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  };
}

export function createOidcProvider(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Allow an http:// issuer. Tests and local development only. */
  allowInsecure?: boolean;
}): OidcProvider {
  let discovered: Promise<client.Configuration> | null = null;
  const configuration = () => {
    discovered ??= client
      .discovery(
        new URL(options.issuer),
        options.clientId,
        options.clientSecret,
        undefined,
        options.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        discovered = null;
        throw err;
      });
    return discovered;
  };
  return {
    async authorizationUrl(redirectUri, checks) {
      const config = await configuration();
      return client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: options.scopes,
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
      });
    },
    async exchange(callbackUrl, checks) {
      const config = await configuration();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('no ID token in the token response');
      const identity: OidcIdentity = { issuer: claims.iss, subject: claims.sub };
      if (typeof claims.email === 'string') identity.email = claims.email;
      if (typeof claims.email_verified === 'boolean')
        identity.emailVerified = claims.email_verified;
      if (typeof claims.name === 'string') identity.name = claims.name;
      return identity;
    },
  };
}
