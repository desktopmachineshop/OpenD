import { hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { deriveSecretKey } from '@opend/store';
import type { BrokerConfig, GitHubAppConfig } from '@opend/worker';

/** Optional string where an empty value (e.g. an unresolved reference variable) counts as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** Every setting comes from the environment, like the docs server. */
const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    EDITOR_PUBLIC_URL: z.url(),
    PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    HOST: z.string().default('0.0.0.0'),
    EDITOR_SESSION_SECRET: optional(
      z.string().min(32, 'EDITOR_SESSION_SECRET must be at least 32 characters'),
    ),
    /** The docs site's: signs editor sessions under its own label, and opens stored secrets. */
    SESSION_SECRET: optional(z.string().min(32, 'SESSION_SECRET must be at least 32 characters')),
    OPEND_SECRET_KEY: optional(
      z.string().min(32, 'OPEND_SECRET_KEY must be at least 32 characters'),
    ),
    GITHUB_APP_ID: optional(z.string().min(1)),
    GITHUB_APP_PRIVATE_KEY: optional(z.string().min(1)),
    OPEND_GITHUB_BROKER_URL: optional(z.url()),
    OPEND_GITHUB_BROKER_SECRET: optional(z.string().min(16)),
    GITHUB_API_URL: optional(z.url()),
    GITHUB_WEB_URL: optional(z.url()),
    GITHUB_OAUTH_CLIENT_ID: optional(z.string().min(1)),
    GITHUB_OAUTH_CLIENT_SECRET: optional(z.string().min(1)),
    EDITOR_OIDC_ISSUER: optional(z.url()),
    EDITOR_OIDC_CLIENT_ID: optional(z.string().min(1)),
    EDITOR_OIDC_CLIENT_SECRET: optional(z.string().min(1)),
    EDITOR_OIDC_SCOPES: z.string().default('openid email profile'),
    EDITOR_REPO: optional(z.string().min(1)),
    OPEND_SITE_REPO: optional(z.string().min(1)),
    EDITOR_BASE_BRANCH: z.string().min(1).default('main'),
    /** The docs site, if any: the editor refuses to share its host. */
    PUBLIC_URL: optional(z.url()),
    NODE_ENV: z.string().default('development'),
  })
  .refine((e) => !e.GITHUB_OAUTH_CLIENT_ID === !e.GITHUB_OAUTH_CLIENT_SECRET, {
    message: 'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set together',
    path: ['GITHUB_OAUTH_CLIENT_ID'],
  })
  .refine(
    (e) => !e.EDITOR_OIDC_ISSUER || (e.EDITOR_OIDC_CLIENT_ID && e.EDITOR_OIDC_CLIENT_SECRET),
    {
      message: 'EDITOR_OIDC_ISSUER needs EDITOR_OIDC_CLIENT_ID and EDITOR_OIDC_CLIENT_SECRET',
      path: ['EDITOR_OIDC_ISSUER'],
    },
  )
  .refine((e) => e.EDITOR_SESSION_SECRET || e.SESSION_SECRET, {
    message: "set SESSION_SECRET (the docs site's) or EDITOR_SESSION_SECRET",
    path: ['EDITOR_SESSION_SECRET'],
  })
  .refine((e) => !e.GITHUB_APP_ID === !e.GITHUB_APP_PRIVATE_KEY, {
    message: 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together',
    path: ['GITHUB_APP_ID'],
  })
  .refine((e) => !e.OPEND_GITHUB_BROKER_URL === !e.OPEND_GITHUB_BROKER_SECRET, {
    message: 'OPEND_GITHUB_BROKER_URL and OPEND_GITHUB_BROKER_SECRET must be set together',
    path: ['OPEND_GITHUB_BROKER_URL'],
  })
  .refine((e) => !e.PUBLIC_URL || separateHosts(e.EDITOR_PUBLIC_URL, e.PUBLIC_URL, e.NODE_ENV), {
    message:
      'EDITOR_PUBLIC_URL must be on its own host, not the docs site (PUBLIC_URL); in production use a different host name',
    path: ['EDITOR_PUBLIC_URL'],
  })
  .refine((e) => isBranchName(e.EDITOR_BASE_BRANCH), {
    message: 'EDITOR_BASE_BRANCH is not a valid branch name',
    path: ['EDITOR_BASE_BRANCH'],
  });

/**
 * The editor and the docs site must not share an origin. In production they
 * must not share a host name either, because cookies ignore ports.
 */
function separateHosts(editorUrl: string, siteUrl: string, nodeEnv: string): boolean {
  const editor = new URL(editorUrl);
  const site = new URL(siteUrl);
  if (nodeEnv === 'production') return editor.hostname !== site.hostname;
  return editor.host !== site.host;
}

/**
 * The editor's cookie key when only the docs site's SESSION_SECRET is given:
 * derived under its own label, so it never equals the docs site's key.
 */
export function editorSessionSecret(sessionSecret: string): string {
  return Buffer.from(
    hkdfSync('sha256', sessionSecret, 'opend-editor', 'opend-editor-session', 32),
  ).toString('base64url');
}

export function isBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//')
  );
}

export interface EditorConfig {
  databaseUrl: string;
  /** Origin the editor is served from, without a trailing slash. */
  publicUrl: string;
  port: number;
  host: string;
  sessionSecret: string;
  /**
   * The GitHub App from the environment. Without it (and without the broker),
   * the editor uses the app the docs site's admin console connected.
   */
  github?: GitHubAppConfig;
  /** Managed hosting: installation tokens from the control plane's broker. */
  broker?: BrokerConfig;
  /** Opens the secrets the admin console stored (same key as the docs site), or null. */
  secretKey: Buffer | null;
  /** GitHub web and API URLs, for GitHub Enterprise Server. */
  githubWebUrl: string;
  githubApiUrl?: string;
  /** GitHub sign-in for developers (OAuth app, or the GitHub App's own OAuth credentials). */
  githubOAuth?: { clientId: string; clientSecret: string; webUrl: string; apiUrl?: string };
  /** Company sign-in for other authors. */
  oidc?: { issuer: string; clientId: string; clientSecret: string; scopes: string };
  /** `owner/name` of the repository to edit; defaults to the site repo or the only one registered. */
  repo?: string;
  baseBranch: string;
  production: boolean;
}

export function loadEditorConfig(env: NodeJS.ProcessEnv = process.env): EditorConfig {
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
  );
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid editor configuration:\n${problems}`);
  }
  const e = parsed.data;
  const config: EditorConfig = {
    databaseUrl: e.DATABASE_URL,
    publicUrl: new URL(e.EDITOR_PUBLIC_URL).origin,
    port: e.PORT,
    host: e.HOST,
    sessionSecret: e.EDITOR_SESSION_SECRET ?? editorSessionSecret(e.SESSION_SECRET!),
    secretKey: deriveSecretKey({ secretKey: e.OPEND_SECRET_KEY, sessionSecret: e.SESSION_SECRET }),
    githubWebUrl: (e.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
    baseBranch: e.EDITOR_BASE_BRANCH,
    production: e.NODE_ENV === 'production',
  };
  if (e.GITHUB_API_URL) config.githubApiUrl = e.GITHUB_API_URL;
  if (e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY) {
    config.github = { appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY };
    if (e.GITHUB_API_URL) config.github.apiUrl = e.GITHUB_API_URL;
  } else if (e.OPEND_GITHUB_BROKER_URL && e.OPEND_GITHUB_BROKER_SECRET) {
    config.broker = { url: e.OPEND_GITHUB_BROKER_URL, secret: e.OPEND_GITHUB_BROKER_SECRET };
    if (e.GITHUB_API_URL) config.broker.apiUrl = e.GITHUB_API_URL;
    if (e.GITHUB_WEB_URL) config.broker.webUrl = e.GITHUB_WEB_URL;
  }
  if (e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET) {
    config.githubOAuth = {
      clientId: e.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET,
      webUrl: (e.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
    };
    if (e.GITHUB_API_URL) config.githubOAuth.apiUrl = e.GITHUB_API_URL;
  }
  if (e.EDITOR_OIDC_ISSUER && e.EDITOR_OIDC_CLIENT_ID && e.EDITOR_OIDC_CLIENT_SECRET) {
    config.oidc = {
      issuer: e.EDITOR_OIDC_ISSUER,
      clientId: e.EDITOR_OIDC_CLIENT_ID,
      clientSecret: e.EDITOR_OIDC_CLIENT_SECRET,
      scopes: e.EDITOR_OIDC_SCOPES,
    };
  }
  const repo = e.EDITOR_REPO ?? e.OPEND_SITE_REPO;
  if (repo) config.repo = repo;
  return config;
}
