import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNELS,
  SecretBox,
  SettingsCache,
  consumeSetupToken,
  countStaffReaders,
  createSetupToken,
  createTestDatabase,
  deleteSecret,
  deriveSecretKey,
  listen,
  loadSettings,
  putSecret,
  putSetting,
  setupTokenValid,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();
const SESSION = 'session-secret-0123456789abcdef0123456789';

describe('secret keys and sealing', () => {
  it('derives distinct keys for OPEND_SECRET_KEY and SESSION_SECRET', () => {
    const fromSession = deriveSecretKey({ sessionSecret: SESSION })!;
    const fromKey = deriveSecretKey({ secretKey: SESSION, sessionSecret: 'other' })!;
    expect(fromSession).toHaveLength(32);
    expect(fromKey.equals(fromSession)).toBe(false);
    // Never the session secret itself, so a leaked session key is not the encryption key.
    expect(fromSession.toString('utf8')).not.toContain(SESSION.slice(0, 8));
    expect(deriveSecretKey({})).toBeNull();
  });

  it('round-trips, and refuses another key, another name or tampering', () => {
    const box = new SecretBox(deriveSecretKey({ sessionSecret: SESSION })!);
    const sealed = box.encrypt('github.privateKey', 'pem-contents');
    expect(sealed).not.toContain('pem-contents');
    expect(box.decrypt('github.privateKey', sealed)).toBe('pem-contents');
    expect(box.decrypt('oidc.clientSecret', sealed)).toBeNull();
    const other = new SecretBox(deriveSecretKey({ sessionSecret: `${SESSION}x` })!);
    expect(other.decrypt('github.privateKey', sealed)).toBeNull();
    expect(other.keyId).not.toBe(box.keyId);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('forged').toString('base64url');
    expect(box.decrypt('github.privateKey', parts.join('.'))).toBeNull();
    // A fresh IV every time.
    expect(box.encrypt('a', 'same')).not.toBe(box.encrypt('a', 'same'));
  });
});

describe.skipIf(!url)('settings in Postgres', () => {
  let db: TestDatabase;
  const box = new SecretBox(deriveSecretKey({ sessionSecret: SESSION })!);
  beforeAll(async () => {
    db = await createTestDatabase(url!);
  });
  afterAll(async () => db?.drop());

  it('stores secrets sealed and reads them back', async () => {
    await putSetting(db.pool, 'oidc', { issuer: 'https://idp.example' }, 'test');
    await putSecret(db.pool, box, 'oidc.clientSecret', 'very-secret-value', 'test');
    const raw = await db.pool.query('select * from secrets');
    expect(JSON.stringify(raw.rows)).not.toContain('very-secret-value');
    expect(raw.rows[0]).toMatchObject({ name: 'oidc.clientSecret', key_id: box.keyId });
    const snap = await loadSettings(db.pool, box);
    expect(snap.values.oidc).toEqual({ issuer: 'https://idp.example' });
    expect(snap.secrets['oidc.clientSecret']).toBe('very-secret-value');
    expect(snap.unreadable).toEqual([]);
  });

  it('reports secrets another key sealed as unreadable, not as values', async () => {
    const other = new SecretBox(
      deriveSecretKey({ sessionSecret: 'rotated-session-secret-xxxxxxxxxxxxxxxx' })!,
    );
    const snap = await loadSettings(db.pool, other);
    expect(snap.secrets).toEqual({});
    expect(snap.unreadable).toEqual(['oidc.clientSecret']);
    expect((await loadSettings(db.pool, null)).unreadable).toEqual(['oidc.clientSecret']);
  });

  it('notifies on every change, and the cache reloads on the notification', async () => {
    const seen: string[] = [];
    const listener = listen(db.url, [CHANNELS.settingsChanged], (_c, payload) =>
      seen.push(payload),
    );
    const cache = new SettingsCache(db.pool, box);
    const cacheListener = cache.listen(db.url);
    await Promise.all([listener.ready, cacheListener.ready]);
    await putSetting(db.pool, 'editor', { url: 'https://edit.example' }, 'test');
    await deleteSecret(db.pool, 'oidc.clientSecret');
    await expect.poll(() => seen).toEqual(['editor', 'secret:oidc.clientSecret']);
    await expect
      .poll(() => cache.current.values.editor, { timeout: 5000 })
      .toEqual({ url: 'https://edit.example' });
    await expect.poll(() => cache.current.secrets['oidc.clientSecret']).toBeUndefined();
    await listener.stop();
    await cacheListener.stop();
  });

  it('makes setup tokens single-use and short-lived, storing only a hash', async () => {
    const { token } = await createSetupToken(db.pool, { minutes: 30, actor: 'cli' });
    const stored = await db.pool.query('select token_hash from admin_setup_tokens');
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(await setupTokenValid(db.pool, token)).toBe(true);
    expect(await setupTokenValid(db.pool, `${token.slice(0, -1)}A`)).toBe(false);
    expect(await consumeSetupToken(db.pool, token)).toBe(true);
    expect(await consumeSetupToken(db.pool, token)).toBe(false);
    expect(await setupTokenValid(db.pool, token)).toBe(false);
    const expired = await createSetupToken(db.pool, { minutes: 30, actor: 'cli' });
    await db.pool.query("update admin_setup_tokens set expires_at = now() - interval '1 second'");
    expect(await consumeSetupToken(db.pool, expired.token)).toBe(false);
    expect(await setupTokenValid(db.pool, 'not a token')).toBe(false);
    expect(await countStaffReaders(db.pool)).toBe(0);
  });
});
