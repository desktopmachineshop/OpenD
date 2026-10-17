import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { CHANNELS, listen, notify, type Db, type Listener, type Pool } from './db.js';

/**
 * Settings that site owners change in the admin console, stored as JSON per
 * key, and secrets (client secrets, private keys, webhook secrets) stored
 * encrypted at rest with AES-256-GCM. Environment variables, where set, take
 * precedence over both; see ADR 0011.
 */

/** HKDF labels: each derived key is used for one purpose only. */
const SECRET_KEY_INFO = 'opend-settings-secrets-v1';
const KEY_ID_INFO = 'opend-secret-key-id';

/**
 * The key that encrypts stored secrets: from `OPEND_SECRET_KEY` when set,
 * otherwise derived from `SESSION_SECRET` under a distinct HKDF label (so
 * rotating `SESSION_SECRET` then makes stored secrets unreadable until they
 * are entered again). `null` when neither is available.
 */
export function deriveSecretKey(options: {
  secretKey?: string | undefined;
  sessionSecret?: string | undefined;
}): Buffer | null {
  const ikm = options.secretKey ?? options.sessionSecret;
  if (!ikm) return null;
  const salt = options.secretKey ? 'opend-secret-key' : 'opend-session-secret';
  return Buffer.from(hkdfSync('sha256', ikm, salt, SECRET_KEY_INFO, 32));
}

/** AES-256-GCM with a random 96-bit IV; the secret's name is the associated data. */
export class SecretBox {
  /** Short fingerprint of the key, stored with each secret to tell "other key" from "corrupt". */
  readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('secret key must be 32 bytes');
    this.keyId = createHmac('sha256', key).update(KEY_ID_INFO).digest('hex').slice(0, 16);
  }

  encrypt(name: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, body]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** The plaintext, or `null` when the value was not sealed with this key for this name. */
  decrypt(name: string, sealed: string): string | null {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || iv === undefined || tag === undefined || body === undefined)
      return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(name, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}

export interface SettingsSnapshot {
  /** Non-secret settings by key. */
  values: Record<string, unknown>;
  /** Decrypted secrets by name. Never render, log or return these. */
  secrets: Record<string, string>;
  /** Secrets that are stored but cannot be decrypted with this process's key. */
  unreadable: string[];
  /** When the snapshot was read, epoch ms (0 for the empty snapshot). */
  loadedAt: number;
}

export const EMPTY_SETTINGS: SettingsSnapshot = Object.freeze({
  values: {},
  secrets: {},
  unreadable: [],
  loadedAt: 0,
}) as SettingsSnapshot;

/** Reads every setting and decrypts every secret this key can open. */
export async function loadSettings(db: Db, box: SecretBox | null): Promise<SettingsSnapshot> {
  const settings = await db.query<{ key: string; value: unknown }>(
    'select key, value from settings',
  );
  const secrets = await db.query<{ name: string; sealed: string }>(
    'select name, sealed from secrets',
  );
  const snapshot: SettingsSnapshot = {
    values: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
    secrets: {},
    unreadable: [],
    loadedAt: Date.now(),
  };
  for (const row of secrets.rows) {
    const plain = box?.decrypt(row.name, row.sealed) ?? null;
    if (plain === null) snapshot.unreadable.push(row.name);
    else snapshot.secrets[row.name] = plain;
  }
  return snapshot;
}

/** Stores a setting and tells every process to reload. */
export async function putSetting(
  db: Db,
  key: string,
  value: unknown,
  actor: string,
): Promise<void> {
  await db.query(
    `insert into settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by,
       updated_at = now()`,
    [key, JSON.stringify(value), actor],
  );
  await notify(db, CHANNELS.settingsChanged, key);
}

export async function deleteSetting(db: Db, key: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from settings where key = $1', [key]);
  await notify(db, CHANNELS.settingsChanged, key);
  return rowCount === 1;
}

/** Encrypts and stores a secret. The plaintext never reaches the database. */
export async function putSecret(
  db: Db,
  box: SecretBox,
  name: string,
  value: string,
  actor: string,
): Promise<void> {
  await db.query(
    `insert into secrets (name, sealed, key_id, updated_by) values ($1, $2, $3, $4)
     on conflict (name) do update set sealed = excluded.sealed, key_id = excluded.key_id,
       updated_by = excluded.updated_by, updated_at = now()`,
    [name, box.encrypt(name, value), box.keyId, actor],
  );
  await notify(db, CHANNELS.settingsChanged, `secret:${name}`);
}

export async function deleteSecret(db: Db, name: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from secrets where name = $1', [name]);
  await notify(db, CHANNELS.settingsChanged, `secret:${name}`);
  return rowCount === 1;
}

/**
 * The latest settings snapshot of one process. `reload()` reads the database
 * again; `listen()` reloads on every `opend_settings_changed` notification,
 * so a change in the admin console reaches the web, worker and editor
 * processes without a restart.
 */
export class SettingsCache {
  private snapshot: SettingsSnapshot = EMPTY_SETTINGS;
  private loading: Promise<SettingsSnapshot> | null = null;
  private again = false;

  constructor(
    private readonly pool: Pool,
    private readonly box: SecretBox | null,
    private readonly onChange: (snapshot: SettingsSnapshot) => void = () => {},
  ) {}

  get current(): SettingsSnapshot {
    return this.snapshot;
  }

  /** Whether stored secrets can be written (a secret key is configured). */
  get canStoreSecrets(): boolean {
    return this.box !== null;
  }

  get secretBox(): SecretBox | null {
    return this.box;
  }

  /** Reads the settings again. Concurrent calls share one read, plus one more if asked meanwhile. */
  reload(): Promise<SettingsSnapshot> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      try {
        do {
          this.again = false;
          this.snapshot = await loadSettings(this.pool, this.box);
        } while (this.again);
        this.onChange(this.snapshot);
        return this.snapshot;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Reloads in the background when the snapshot is older than `maxAgeMs` (a missed notification). */
  refreshIfStale(maxAgeMs: number, onError: (err: unknown) => void): void {
    if (Date.now() - this.snapshot.loadedAt > maxAgeMs && !this.loading)
      this.reload().catch(onError);
  }

  listen(databaseUrl: string, onError: (err: unknown) => void = () => {}): Listener {
    return listen(
      databaseUrl,
      [CHANNELS.settingsChanged],
      () => void this.reload().catch(onError),
      onError,
    );
  }
}

// ---- one-time admin setup links -------------------------------------------

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * A single-use setup token for the first staff reader. Only its hash is
 * stored; the raw token goes into the link and nowhere else.
 */
export async function createSetupToken(
  db: Db,
  options: { minutes: number; actor: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ expiresAt: Date }>(
    `insert into admin_setup_tokens (token_hash, expires_at, created_by)
     values ($1, now() + make_interval(mins => $2), $3) returning expires_at as "expiresAt"`,
    [hashToken(token), options.minutes, options.actor],
  );
  return { token, expiresAt: rows[0]!.expiresAt };
}

function wellFormed(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Whether a setup token exists, is unused and has not expired. */
export async function setupTokenValid(db: Db, token: string): Promise<boolean> {
  if (!wellFormed(token)) return false;
  // Looked up by hash, so timing reveals nothing about the raw token.
  const { rowCount } = await db.query(
    `select 1 from admin_setup_tokens
     where token_hash = $1 and used_at is null and expires_at > now()`,
    [hashToken(token)],
  );
  return rowCount === 1;
}

/** Uses a setup token up. Returns false when it was unknown, used or expired. */
export async function consumeSetupToken(db: Db, token: string): Promise<boolean> {
  if (!wellFormed(token)) return false;
  const { rowCount } = await db.query(
    `update admin_setup_tokens set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()`,
    [hashToken(token)],
  );
  return rowCount === 1;
}

export async function countStaffReaders(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'select count(*)::int as n from readers where staff',
  );
  return rows[0]!.n;
}
