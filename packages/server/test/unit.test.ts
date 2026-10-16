import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FsBlobStore, S3BlobStore, createBlobStore } from '@opend/store';
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

  it('treats empty variables as unset, as deploy/.env.example leaves them', () => {
    const config = loadConfig({
      ...base,
      PUBLIC_URL: '',
      PORT: '',
      GITHUB_WEBHOOK_SECRET: '',
      GITHUB_APP_ID: '',
      OIDC_ISSUER: '',
      OPEND_ADMIN_TOKEN: '',
      OPEND_SITE_REPO: '',
      OPEND_EMBED_SECRET: '',
      OPEND_EMBED_ORIGINS: '',
      OPEND_DEV_LOGIN: '',
    });
    expect(config).toMatchObject({
      publicUrl: 'http://localhost:3000',
      port: 3000,
      devLogin: false,
    });
    expect(config.webhookSecret).toBeUndefined();
    expect(config.adminToken).toBeUndefined();
    expect(config.embed).toBeUndefined();
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
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

  const s3 = {
    S3_ENDPOINT: 'https://t3.storageapi.dev',
    S3_BUCKET: 'docs-bucket',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('keeps blobs in BLOB_DIR unless S3_BUCKET is set', () => {
    expect(loadConfig(base).blobs).toEqual({ kind: 'fs', dir: './data/blobs' });
    expect(loadConfig({ ...base, BLOB_DIR: '/data/blobs' }).blobs).toEqual({
      kind: 'fs',
      dir: '/data/blobs',
    });
    expect(loadConfig({ ...base, S3_BUCKET: '', S3_REGION: 'us-east-1' }).blobs.kind).toBe('fs');
  });

  it('selects S3 storage when S3_BUCKET is set', () => {
    expect(loadConfig({ ...base, ...s3 }).blobs).toEqual({
      kind: 's3',
      endpoint: 'https://t3.storageapi.dev',
      bucket: 'docs-bucket',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: false,
    });
    expect(
      loadConfig({
        ...base,
        ...s3,
        S3_REGION: 'eu-west-1',
        S3_FORCE_PATH_STYLE: 'true',
        S3_PREFIX: 'opend/',
      }).blobs,
    ).toMatchObject({ region: 'eu-west-1', forcePathStyle: true, prefix: 'opend/' });
  });

  it('requires the S3 bucket, endpoint and keys together', () => {
    const together = /S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/;
    expect(() => loadConfig({ ...base, S3_BUCKET: 'docs' })).toThrow(together);
    expect(() => loadConfig({ ...base, ...s3, S3_ENDPOINT: undefined })).toThrow(together);
    expect(() => loadConfig({ ...base, ...s3, S3_SECRET_ACCESS_KEY: '' })).toThrow(together);
    expect(() => loadConfig({ ...base, S3_ACCESS_KEY_ID: 'key' })).toThrow(together);
    expect(() => loadConfig({ ...base, ...s3, S3_ENDPOINT: 'not a url' })).toThrow(/S3_ENDPOINT/);
  });
});

describe('createBlobStore', () => {
  it('builds the store the configuration names', () => {
    expect(createBlobStore({ kind: 'fs', dir: '/tmp/blobs' })).toBeInstanceOf(FsBlobStore);
    const store = createBlobStore({
      kind: 's3',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'docs',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(store).toBeInstanceOf(S3BlobStore);
    (store as S3BlobStore).destroy();
  });
});
