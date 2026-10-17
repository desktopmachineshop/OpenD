import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { entitlementKey } from '@opend/model';
import { readerPolicy } from '@opend/filter';
import {
  FsBlobStore,
  S3BlobStore,
  createBlobStore,
  type ReaderAccess,
  type Repo,
} from '@opend/store';
import {
  NOTHING_GATED,
  audienceFor,
  sourceHref,
  type Audience,
  loadConfig,
  safeReturnTo,
  shortRef,
  sourceUrlSchema,
  verifySignature,
} from '../src/index.js';

describe('sourceUrlSchema', () => {
  const ok = (production: boolean, url: string) =>
    sourceUrlSchema(production).safeParse(url).success;

  it('accepts https clone URLs everywhere', () => {
    for (const production of [true, false]) {
      expect(ok(production, 'https://github.com/acme/docs.git')).toBe(true);
      expect(ok(production, 'https://ghe.example:8443/acme/docs.git')).toBe(true);
    }
  });

  it('accepts local paths and file: URLs only outside production', () => {
    for (const url of ['/srv/docs', 'file:///srv/docs']) {
      expect(ok(false, url), url).toBe(true);
      expect(ok(true, url), url).toBe(false);
    }
  });

  it('rejects other schemes, relative paths and option-like values', () => {
    for (const production of [true, false]) {
      for (const url of [
        'http://github.com/acme/docs.git',
        'ssh://git@github.com/acme/docs.git',
        'git@github.com:acme/docs.git',
        'ext::sh -c touch% /tmp/pwned',
        '--upload-pack=touch /tmp/pwned',
        'docs',
        'https://',
        '',
      ]) {
        expect(ok(production, url), url).toBe(false);
      }
    }
  });
});

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

  it('turns analytics on by default and off with OPEND_ANALYTICS=0', () => {
    expect(loadConfig(base).analytics).toEqual({ enabled: true, retentionDays: 180 });
    expect(loadConfig({ ...base, OPEND_ANALYTICS: '' }).analytics?.enabled).toBe(true);
    for (const off of ['0', 'false', 'off'])
      expect(loadConfig({ ...base, OPEND_ANALYTICS: off }).analytics?.enabled).toBe(false);
    expect(
      loadConfig({ ...base, OPEND_ANALYTICS_RETENTION_DAYS: '30' }).analytics?.retentionDays,
    ).toBe(30);
    expect(() => loadConfig({ ...base, OPEND_ANALYTICS_RETENTION_DAYS: '0' })).toThrow(
      /OPEND_ANALYTICS_RETENTION_DAYS/,
    );
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

describe('audienceFor', () => {
  const repo = (access: 'private' | 'public', pub: Repo['publicEntitlements'] = null): Repo => ({
    id: 1,
    fullName: 'acme/docs',
    sourceUrl: 'https://github.com/acme/docs.git',
    installationId: null,
    releaseRefs: ['main'],
    docsPath: '.',
    access,
    publicEntitlements: pub,
  });
  const reader = (context: ReaderAccess['context'], staff = false): ReaderAccess => ({
    reader: {
      id: 1,
      orgId: 1,
      email: 'r@example.com',
      name: null,
      oidcIssuer: null,
      oidcSubject: null,
      staff,
    },
    orgSlug: 'acme',
    context,
  });
  const own = { products: ['gadget'], features: ['sso'], version: '2.0' };
  const pub = { products: ['widget'], features: [], version: '2.4' };

  it('keeps private sites closed to anonymous visitors and readers without entitlements', () => {
    expect(audienceFor(repo('private', pub), null)).toBe('sign-in');
    expect(audienceFor(repo('private', pub), reader(null))).toBe('no-entitlements');
    expect(audienceFor(repo('private', pub), reader(own))).toEqual({
      key: entitlementKey(own),
      context: own,
      line: '2',
    });
  });

  it('shows nothing gated on a public site without public entitlements', () => {
    const a = audienceFor(repo('public'), null);
    expect(a).toEqual({ key: 'public|none', context: NOTHING_GATED, line: null });
    const policy = readerPolicy(NOTHING_GATED);
    expect(policy.decide('product', 'widget')).toBe('exclude');
    expect(policy.decide('feature', 'sso')).toBe('exclude');
    expect(policy.decide('release', '1.0..')).toBe('exclude');
    expect(policy.decide('release', '..9')).toBe('exclude');
  });

  it('gives anonymous visitors their own cache key space', () => {
    const a = audienceFor(repo('public', pub), null) as Audience;
    expect(a.key).toBe(`public|${entitlementKey(pub)}`);
    expect(a.key).not.toBe(entitlementKey(pub));
    expect(audienceFor(repo('public', pub), reader(null))).toEqual(a);
  });

  it('unions a reader with the public set on the same release line only', () => {
    const a = audienceFor(repo('public', pub), reader(own)) as Audience;
    expect(a.context).toEqual({
      products: ['gadget', 'widget'],
      features: ['sso'],
      version: '2.0',
    });
    const other = { ...own, version: '1.9' };
    expect((audienceFor(repo('public', pub), reader(other)) as Audience).context).toEqual(other);
  });

  it('gives staff the unfiltered view in every mode', () => {
    for (const r of [repo('private'), repo('public', pub)]) {
      expect(audienceFor(r, reader(null, true))).toEqual({
        key: 'staff',
        context: null,
        line: null,
      });
      expect(audienceFor(r, reader(own, true))).toEqual({ key: 'staff', context: null, line: '2' });
    }
  });
});

describe('sourceHref', () => {
  const sha = 'a'.repeat(40);
  it('links GitHub repositories at the built commit, inside the docs path', () => {
    expect(
      sourceHref(
        { fullName: 'x/y', sourceUrl: 'https://github.com/acme/docs.git', docsPath: 'docs' },
        sha,
        'topics/a b.dita',
      ),
    ).toBe(`https://github.com/acme/docs/blob/${sha}/docs/topics/a%20b.dita`);
    expect(
      sourceHref(
        { fullName: 'x/y', sourceUrl: 'https://github.com/acme/docs', docsPath: '.' },
        sha,
        't.dita',
      ),
    ).toBe(`https://github.com/acme/docs/blob/${sha}/t.dita`);
  });
  it('gives nothing for other hosts and local sources', () => {
    for (const sourceUrl of [
      '/srv/docs',
      'https://gitlab.com/a/b.git',
      'https://github.com.evil/a/b',
    ])
      expect(sourceHref({ fullName: 'a/b', sourceUrl, docsPath: '.' }, sha, 't.dita')).toBeNull();
  });
});

describe('reader sign-in configuration', () => {
  it('reads GitHub sign-in, the editor URL and source links', () => {
    const config = loadConfig({
      ...base,
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.abc',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'key',
      OPEND_GITHUB_COLLABORATOR_ORG: 'docs-team',
      OPEND_GITHUB_COLLABORATOR_STAFF: '1',
      EDITOR_PUBLIC_URL: 'https://editor.example/',
      OPEND_SOURCE_LINKS: '1',
      OIDC_ISSUER: 'https://id.example',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_DISPLAY_NAME: 'Acme SSO',
    });
    expect(config.githubOAuth).toEqual({
      clientId: 'Iv1.abc',
      clientSecret: 'secret',
      webUrl: 'https://github.com',
      collaboratorOrg: 'docs-team',
      collaboratorStaff: true,
    });
    expect(config.editorUrl).toBe('https://editor.example');
    expect(config.sourceLinks).toBe(true);
    expect(config.oidc?.displayName).toBe('Acme SSO');
  });

  it('refuses half-configured GitHub sign-in and collaborator provisioning', () => {
    expect(() => loadConfig({ ...base, GITHUB_OAUTH_CLIENT_ID: 'x' })).toThrow(
      /GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET/,
    );
    expect(() =>
      loadConfig({
        ...base,
        GITHUB_OAUTH_CLIENT_ID: 'x',
        GITHUB_OAUTH_CLIENT_SECRET: 'y',
        OPEND_GITHUB_COLLABORATOR_ORG: 'team',
      }),
    ).toThrow(/OPEND_GITHUB_COLLABORATOR_ORG needs/);
    expect(() => loadConfig({ ...base, OPEND_GITHUB_COLLABORATOR_STAFF: '1' })).toThrow(
      /OPEND_GITHUB_COLLABORATOR_STAFF needs/,
    );
  });
});
