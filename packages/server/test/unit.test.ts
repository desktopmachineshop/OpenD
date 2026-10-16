import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, safeReturnTo, shortRef, verifySignature } from '../src/index.js';

const base = {
  DATABASE_URL: 'postgres://localhost/opend',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('verifySignature', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const sign = (secret: string, data: Buffer) =>
    `sha256=${createHmac('sha256', secret).update(data).digest('hex')}`;

  it('accepts a valid signature and rejects forged, missing or malformed ones', () => {
    expect(verifySignature('s3cret', body, sign('s3cret', body))).toBe(true);
    expect(verifySignature('s3cret', body, sign('other', body))).toBe(false);
    expect(verifySignature('s3cret', Buffer.from('{"ref":"x"}'), sign('s3cret', body))).toBe(false);
    expect(verifySignature('s3cret', body, undefined)).toBe(false);
    expect(verifySignature('s3cret', body, 'sha1=abc')).toBe(false);
    expect(verifySignature('s3cret', body, 'sha256=short')).toBe(false);
  });
});

describe('shortRef', () => {
  it.each([
    ['refs/heads/main', 'main'],
    ['refs/heads/release/2.0', 'release/2.0'],
    ['refs/tags/v1', 'v1'],
    ['refs/pull/1/head', null],
    ['main', null],
  ])('%s → %s', (ref, expected) => {
    expect(shortRef(ref)).toBe(expected);
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/topics/install.html', '/topics/install.html'],
    ['/a?b=1', '/a?b=1'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%j → %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe('loadConfig', () => {
  it('reads settings from the environment', () => {
    const config = loadConfig({
      ...base,
      PUBLIC_URL: 'https://docs.example/',
      OPEND_DEV_LOGIN: '1',
      PORT: '8080',
    });
    expect(config).toMatchObject({
      publicUrl: 'https://docs.example',
      devLogin: true,
      port: 8080,
      production: false,
    });
    expect(config.oidc).toBeUndefined();
  });

  it('refuses development sign-in in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', OPEND_DEV_LOGIN: 'true' })).toThrow(
      /OPEND_DEV_LOGIN must not be enabled when NODE_ENV=production/,
    );
  });

  it('requires a long session secret and complete OIDC and GitHub App settings', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, OIDC_ISSUER: 'https://idp.example' })).toThrow(
      /OIDC_CLIENT_ID/,
    );
    expect(() => loadConfig({ ...base, GITHUB_APP_ID: '1' })).toThrow(/set together/);
    expect(() => loadConfig({ SESSION_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
