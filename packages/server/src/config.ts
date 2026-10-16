import type { BlobStoreConfig } from '@opend/store';
import { z } from 'zod';

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
    NODE_ENV: z.string().default('development'),
  })
  .refine((e) => !(e.OPEND_DEV_LOGIN && e.NODE_ENV === 'production'), {
    message: 'OPEND_DEV_LOGIN must not be enabled when NODE_ENV=production',
    path: ['OPEND_DEV_LOGIN'],
  })
  .refine((e) => !e.OIDC_ISSUER || (e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET), {
    message: 'OIDC_ISSUER needs OIDC_CLIENT_ID and OIDC_CLIENT_SECRET',
    path: ['OIDC_ISSUER'],
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
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
  return config;
}
