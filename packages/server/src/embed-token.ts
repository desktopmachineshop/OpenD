import { jwtVerify, errors } from 'jose';

/** The longest lifetime an embed token may have. Host backends mint them per page view. */
export const MAX_TOKEN_SECONDS = 600;

export interface EmbedClaims {
  /** The reader's email, as registered in OpenD. */
  email: string;
  /** The reader's org slug; must match the org OpenD has for that email. */
  org: string;
  /** The token's `exp`, in Unix seconds. */
  expiresAt: number;
}

export class EmbedTokenError extends Error {}

/**
 * Verifies a host-signed embed token: HS256 with the shared secret, audience
 * the docs site's PUBLIC_URL, short-lived, and naming a reader and org.
 *
 * The host app's backend mints it for its signed-in user, for example:
 *   new SignJWT({ email, org }).setProtectedHeader({ alg: 'HS256' })
 *     .setAudience('https://docs.example.com').setIssuedAt().setExpirationTime('5m').sign(secret)
 */
export async function verifyEmbedToken(
  token: string,
  secret: string,
  audience: string,
): Promise<EmbedClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience,
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat'],
      // Also rejects an `iat` in the future, which would stretch the lifetime check below.
      maxTokenAge: MAX_TOKEN_SECONDS,
      clockTolerance: 30,
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new EmbedTokenError('token expired');
    throw new EmbedTokenError('invalid token');
  }
  if (payload.exp! - payload.iat! > MAX_TOKEN_SECONDS) {
    throw new EmbedTokenError(`token lifetime must be at most ${MAX_TOKEN_SECONDS} seconds`);
  }
  const email =
    typeof payload.email === 'string'
      ? payload.email
      : typeof payload.sub === 'string'
        ? payload.sub
        : '';
  const org = typeof payload.org === 'string' ? payload.org : '';
  if (!email.includes('@') || !org)
    throw new EmbedTokenError('token must name the reader (email) and org');
  return { email, org, expiresAt: payload.exp! };
}
