import type { BlobStoreConfig } from '@opend/store';
import { z } from 'zod';
import {
  selfHostingConfig,
  selfHostingEnv,
  type SelfHostingConfig,
} from './self-hosting-config.js';

/** `https://app.example.com` or `http://localhost:5173`: scheme, host and port only. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

/** Optional string where an empty value (e.g. an unresolved reference variable) counts as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** Every setting comes from the environment; nothing is baked into the image. */
const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    PUBLIC_URL: z.url().default('http://localhost:3000'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_API_URL: z.url().optional(),
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid email profile'),
    BLOB_DIR: z.string().default('./data/blobs'),
    S3_ENDPOINT: optional(z.url()),
    S3_BUCKET: optional(z.string()),
    S3_REGION: optional(z.string()),
    S3_ACCESS_KEY_ID: optional(z.string()),
    S3_SECRET_ACCESS_KEY: optional(z.string()),
    S3_FORCE_PATH_STYLE: flag,
    S3_PREFIX: optional(z.string()),
    OPEND_ADMIN_TOKEN: z
      .string()
      .min(24, 'OPEND_ADMIN_TOKEN must be at least 24 characters')
      .optional(),
    OPEND_DEV_LOGIN: flag,
    OPEND_SITE_REPO: z.string().min(1).optional(),
    OPEND_EMBED_SECRET: z
      .string()
      .min(32, 'OPEND_EMBED_SECRET must be at least 32 characters')
      .optional(),
    OPEND_EMBED_ORIGINS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .refine((list) => list.every(isOrigin), {
        message:
          'OPEND_EMBED_ORIGINS must be comma-separated origins such as https://app.example.com',
      }),
    // On unless set to 0/false/off; nothing about a reader is recorded either way.
    OPEND_ANALYTICS: z
      .string()
      .optional()
      .transform((v) => !['0', 'false', 'off', 'no'].includes((v ?? '').trim().toLowerCase())),
    OPEND_ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
    NODE_ENV: z.string().default('development'),
    ...selfHostingEnv,
  })
  .refine((e) => !(e.OPEND_DEV_LOGIN && e.NODE_ENV === 'production'), {
    message: 'OPEND_DEV_LOGIN must not be enabled when NODE_ENV=production',
    path: ['OPEND_DEV_LOGIN'],
  })
  .refine((e) => !e.OIDC_ISSUER || (e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET), {
    message: 'OIDC_ISSUER needs OIDC_CLIENT_ID and OIDC_CLIENT_SECRET',
    path: ['OIDC_ISSUER'],
  })
  .refine((e) => !e.OPEND_EMBED_SECRET === (e.OPEND_EMBED_ORIGINS.length === 0), {
    message: 'OPEND_EMBED_SECRET and OPEND_EMBED_ORIGINS must be set together',
    path: ['OPEND_EMBED_SECRET'],
  })
  .refine((e) => !e.GITHUB_APP_ID === !e.GITHUB_APP_PRIVATE_KEY, {
    message: 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together',
    path: ['GITHUB_APP_ID'],
  })
  .refine(
    (e) => {
      const set = [e.S3_BUCKET, e.S3_ENDPOINT, e.S3_ACCESS_KEY_ID, e.S3_SECRET_ACCESS_KEY];
      return set.every(Boolean) || !set.some(Boolean);
    },
    {
      message:
        'S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      path: ['S3_BUCKET'],
    },
  );

export interface AnalyticsConfig {
  enabled: boolean;
  /** Raw events older than this are purged by the worker. */
  retentionDays: number;
}

export const DEFAULT_ANALYTICS: AnalyticsConfig = { enabled: true, retentionDays: 180 };

export interface ServerConfig {
  databaseUrl: string;
  publicUrl: string;
  port: number;
  host: string;
  sessionSecret: string;
  webhookSecret?: string;
  github?: { appId: string; privateKey: string; apiUrl?: string };
  oidc?: { issuer: string; clientId: string; clientSecret: string; scopes: string };
  /** S3-compatible storage when S3_BUCKET is set, otherwise the BLOB_DIR folder. */
  blobs: BlobStoreConfig;
  adminToken?: string;
  devLogin: boolean;
  production: boolean;
  /** Which repository the site serves when more than one is registered. */
  siteRepo?: string;
  /** Embedded help in host apps: the token secret and the origins allowed to frame it. */
  embed?: { secret: string; origins: string[] };
  /**
   * Docs analytics and reader feedback. Absent means on, with the default
   * retention; `enabled: false` records nothing and hides the feedback form.
   */
  analytics?: AnalyticsConfig;
  /** Polling for webhook-less installs, and entitlement sync from billing or a CRM. */
  selfHosting?: SelfHostingConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // `KEY=` in an env file (as in .env.example) arrives as an empty string: treat it as unset.
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
  );
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  const config: ServerConfig = {
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
    port: e.PORT,
    host: e.HOST,
    sessionSecret: e.SESSION_SECRET,
    blobs: { kind: 'fs', dir: e.BLOB_DIR },
    devLogin: e.OPEND_DEV_LOGIN,
    production: e.NODE_ENV === 'production',
    selfHosting: selfHostingConfig(e),
    analytics: { enabled: e.OPEND_ANALYTICS, retentionDays: e.OPEND_ANALYTICS_RETENTION_DAYS },
  };
  if (e.S3_BUCKET && e.S3_ENDPOINT && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY) {
    config.blobs = {
      kind: 's3',
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      region: e.S3_REGION ?? 'auto',
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    };
    if (e.S3_PREFIX) config.blobs.prefix = e.S3_PREFIX;
  }
  if (e.GITHUB_WEBHOOK_SECRET) config.webhookSecret = e.GITHUB_WEBHOOK_SECRET;
  if (e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY) {
    config.github = { appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY };
    if (e.GITHUB_API_URL) config.github.apiUrl = e.GITHUB_API_URL;
  }
  if (e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET) {
    config.oidc = {
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      scopes: e.OIDC_SCOPES,
    };
  }
  if (e.OPEND_ADMIN_TOKEN) config.adminToken = e.OPEND_ADMIN_TOKEN;
  if (e.OPEND_SITE_REPO) config.siteRepo = e.OPEND_SITE_REPO;
  if (e.OPEND_EMBED_SECRET)
    config.embed = { secret: e.OPEND_EMBED_SECRET, origins: e.OPEND_EMBED_ORIGINS };
  return config;
}
