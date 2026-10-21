import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign-in handoffs into the admin console from the managed service's account
 * panel. The service holds each site's OPEND_ADMIN_TOKEN, so it signs a short
 * token with a key derived from it; the site checks the signature, the audience
 * (its own address), the expiry and that the id was not used before, then signs
 * the person in. `owner` marks the person who owns the site at the service:
 * they become staff if they are not already. Nothing else can mint one: the key
 * never leaves the service, and without an admin token the route does not exist.
 *
 * Format: base64url(JSON claims) "." base64url(HMAC-SHA256(key, first part)).
 */

export const HANDOFF_PATH = '/admin/handoff';
/** The longest a handoff may live; the service mints them for a minute. */
export const HANDOFF_MAX_SECONDS = 300;

export interface HandoffClaims {
  v: 1;
  /** The site's public URL origin. */
  aud: string;
  email: string;
  owner: boolean;
  /** Unix seconds. */
  exp: number;
  jti: string;
}

export function handoffKey(adminToken: string): Buffer {
  return createHmac('sha256', adminToken).update('opend admin handoff v1').digest();
}

export function signHandoff(adminToken: string, claims: HandoffClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', handoffKey(adminToken)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The claims of a valid handoff for this site, or null. */
export function verifyHandoff(
  token: string,
  adminToken: string,
  publicUrl: string,
  now = Math.floor(Date.now() / 1000),
): HandoffClaims | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined || token.length > 2048) return null;
  const expected = createHmac('sha256', handoffKey(adminToken)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: Partial<HandoffClaims>;
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<HandoffClaims>;
  } catch {
    return null;
  }
  if (
    c.v !== 1 ||
    c.aud !== new URL(publicUrl).origin ||
    typeof c.email !== 'string' ||
    !c.email.includes('@') ||
    typeof c.owner !== 'boolean' ||
    typeof c.exp !== 'number' ||
    c.exp <= now ||
    c.exp > now + HANDOFF_MAX_SECONDS ||
    typeof c.jti !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(c.jti)
  )
    return null;
  return c as HandoffClaims;
}
