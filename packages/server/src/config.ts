import type { BlobStoreConfig } from '@opend/store';
import type { BrokerConfig } from '@opend/worker';
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
    OPEND_SECRET_KEY: optional(
      z.string().min(32, 'OPEND_SECRET_KEY must be at least 32 characters'),
    ),
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_API_URL: z.url().optional(),
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid email profile'),
    OIDC_DISPLAY_NAME: optional(z.string().min(1).max(60)),
    OIDC_ICON: optional(z.enum(['github', 'key'])),
    GITHUB_OAUTH_CLIENT_ID: optional(z.string().min(1)),
    GITHUB_OAUTH_CLIENT_SECRET: optional(z.string().min(1)),
    GITHUB_WEB_URL: optional(z.url()),
    OPEND_GITHUB_BROKER_URL: optional(z.url()),
    OPEND_GITHUB_BROKER_SECRET: optional(
      z.string().min(16, 'OPEND_GITHUB_BROKER_SECRET must be at least 16 characters'),
    ),
    OPEND_GITHUB_INSTALL_URL: optional(z.url()),
    OPEND_GITHUB_COLLABORATOR_ORG: optional(
      z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'an org slug'),
    ),
    OPEND_GITHUB_COLLABORATOR_STAFF: flag,
    EDITOR_PUBLIC_URL: optional(z.url()),
    OPEND_SOURCE_LINKS: flag,
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
  .refine((e) => !e.GITHUB_OAUTH_CLIENT_ID === !e.GITHUB_OAUTH_CLIENT_SECRET, {
    message: 'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set together',
    path: ['GITHUB_OAUTH_CLIENT_ID'],
  })
  .refine(
    (e) => !e.OPEND_GITHUB_COLLABORATOR_ORG || (e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_APP_ID),
    {
      message:
        'OPEND_GITHUB_COLLABORATOR_ORG needs GitHub sign-in (GITHUB_OAUTH_CLIENT_ID) and the GitHub App (GITHUB_APP_ID) to check repository access',
      path: ['OPEND_GITHUB_COLLABORATOR_ORG'],
    },
  )
  .refine((e) => !e.OPEND_GITHUB_COLLABORATOR_STAFF || e.OPEND_GITHUB_COLLABORATOR_ORG, {
    message: 'OPEND_GITHUB_COLLABORATOR_STAFF needs OPEND_GITHUB_COLLABORATOR_ORG',
    path: ['OPEND_GITHUB_COLLABORATOR_STAFF'],
  })
  .refine((e) => !e.OPEND_EMBED_SECRET === (e.OPEND_EMBED_ORIGINS.length === 0), {
    message: 'OPEND_EMBED_SECRET and OPEND_EMBED_ORIGINS must be set together',
    path: ['OPEND_EMBED_SECRET'],
  })
  .refine((e) => !e.GITHUB_APP_ID === !e.GITHUB_APP_PRIVATE_KEY, {
    message: 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together',
    path: ['GITHUB_APP_ID'],
  })
  .refine((e) => !e.OPEND_GITHUB_BROKER_URL === !e.OPEND_GITHUB_BROKER_SECRET, {
    message: 'OPEND_GITHUB_BROKER_URL and OPEND_GITHUB_BROKER_SECRET must be set together',
    path: ['OPEND_GITHUB_BROKER_URL'],
  })
  .refine((e) => !(e.OPEND_GITHUB_BROKER_URL && e.GITHUB_APP_ID), {
    message: 'set either GITHUB_APP_ID (your own GitHub App) or OPEND_GITHUB_BROKER_URL, not both',
    path: ['OPEND_GITHUB_BROKER_URL'],
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
  /** `OPEND_SECRET_KEY`: seals stored secrets. Without it, a key derived from `sessionSecret`. */
  secretKey?: string;
  webhookSecret?: string;
  github?: { appId: string; privateKey: string; apiUrl?: string };
  /** GitHub (or GitHub Enterprise Server) web and API URLs. */
  githubWebUrl?: string;
  githubApiUrl?: string;
  /**
   * Managed hosting: installation tokens come from the control plane's broker,
   * and `installUrl` is the shared app's installation page.
   */
  broker?: BrokerConfig & { installUrl?: string };
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    /** Shown on the sign-in page as "Sign in with <displayName>". */
    displayName?: string;
    /** The sign-in button's icon; `github` when the provider is GitHub (managed hosting). */
    icon?: 'github' | 'key';
  };
  /**
   * Reader sign-in with GitHub: the same OAuth credentials as the editor's
   * (one GitHub App serves both; each host has its own callback URL).
   */
  githubOAuth?: {
    clientId: string;
    clientSecret: string;
    webUrl: string;
    apiUrl?: string;
    /**
     * Readers who sign in with GitHub and can push to the site's repository
     * are added to this org on first sign-in (off when absent).
     */
    collaboratorOrg?: string;
    /** Such collaborators also get the staff view. */
    collaboratorStaff?: boolean;
  };
  /** The web editor's origin: signed-in readers get "Edit this page" links. */
  editorUrl?: string;
  /** "Edit this page" links on (the default) or off, when the editor is configured. */
  editLinks?: boolean;
  /** "View source on GitHub" links on topic pages of repositories hosted on GitHub. */
  sourceLinks?: boolean;
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
  if (e.OPEND_SECRET_KEY) config.secretKey = e.OPEND_SECRET_KEY;
  if (e.GITHUB_WEB_URL) config.githubWebUrl = e.GITHUB_WEB_URL.replace(/\/$/, '');
  if (e.GITHUB_API_URL) config.githubApiUrl = e.GITHUB_API_URL.replace(/\/$/, '');
  if (e.OPEND_GITHUB_BROKER_URL && e.OPEND_GITHUB_BROKER_SECRET) {
    config.broker = { url: e.OPEND_GITHUB_BROKER_URL, secret: e.OPEND_GITHUB_BROKER_SECRET };
    if (e.GITHUB_API_URL) config.broker.apiUrl = e.GITHUB_API_URL;
    if (e.GITHUB_WEB_URL) config.broker.webUrl = e.GITHUB_WEB_URL;
    if (e.OPEND_GITHUB_INSTALL_URL) config.broker.installUrl = e.OPEND_GITHUB_INSTALL_URL;
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
    if (e.OIDC_DISPLAY_NAME) config.oidc.displayName = e.OIDC_DISPLAY_NAME;
    const icon =
      e.OIDC_ICON ??
      (e.OIDC_DISPLAY_NAME?.trim().toLowerCase() === 'github' ? 'github' : undefined);
    if (icon) config.oidc.icon = icon;
  }
  if (e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET) {
    config.githubOAuth = {
      clientId: e.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET,
      webUrl: (e.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
    };
    if (e.GITHUB_API_URL) config.githubOAuth.apiUrl = e.GITHUB_API_URL;
    if (e.OPEND_GITHUB_COLLABORATOR_ORG) {
      config.githubOAuth.collaboratorOrg = e.OPEND_GITHUB_COLLABORATOR_ORG;
      config.githubOAuth.collaboratorStaff = e.OPEND_GITHUB_COLLABORATOR_STAFF;
    }
  }
  if (e.EDITOR_PUBLIC_URL) config.editorUrl = new URL(e.EDITOR_PUBLIC_URL).origin;
  if (e.OPEND_SOURCE_LINKS) config.sourceLinks = true;
  if (e.OPEND_ADMIN_TOKEN) config.adminToken = e.OPEND_ADMIN_TOKEN;
  if (e.OPEND_SITE_REPO) config.siteRepo = e.OPEND_SITE_REPO;
  if (e.OPEND_EMBED_SECRET)
    config.embed = { secret: e.OPEND_EMBED_SECRET, origins: e.OPEND_EMBED_ORIGINS };
  return config;
}
