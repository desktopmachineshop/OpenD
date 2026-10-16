import { z } from 'zod';

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
    EDITOR_SESSION_SECRET: z
      .string()
      .min(32, 'EDITOR_SESSION_SECRET must be at least 32 characters'),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
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
  .refine((e) => e.GITHUB_OAUTH_CLIENT_ID || e.EDITOR_OIDC_ISSUER, {
    message: 'configure at least one sign-in: GITHUB_OAUTH_CLIENT_ID or EDITOR_OIDC_ISSUER',
    path: ['GITHUB_OAUTH_CLIENT_ID'],
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
  github: { appId: string; privateKey: string; apiUrl?: string };
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
  const parsed = envSchema.safeParse(env);
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
    sessionSecret: e.EDITOR_SESSION_SECRET,
    github: { appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY },
    baseBranch: e.EDITOR_BASE_BRANCH,
    production: e.NODE_ENV === 'production',
  };
  if (e.GITHUB_API_URL) config.github.apiUrl = e.GITHUB_API_URL;
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
