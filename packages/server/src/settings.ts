import {
  SETTING,
  SECRET,
  settingFlag,
  settingString,
  storedGitHubApp,
  type SettingsSnapshot,
} from '@opend/store';
import type { ServerConfig } from './config.js';

/**
 * Where an effective setting comes from, for the admin console: `env`
 * settings are read-only there ("remove the variable to edit it here").
 */
export type SettingSource = 'env' | 'console' | 'broker' | 'none';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The OIDC provider stored in the admin console, if complete. */
export function storedOidc(snapshot: SettingsSnapshot): ServerConfig['oidc'] | null {
  const v = snapshot.values[SETTING.oidc];
  const clientSecret = snapshot.secrets[SECRET.oidcClientSecret];
  if (!isRecord(v) || typeof v.issuer !== 'string' || typeof v.clientId !== 'string') return null;
  if (!clientSecret) return null;
  const oidc: NonNullable<ServerConfig['oidc']> = {
    issuer: v.issuer,
    clientId: v.clientId,
    clientSecret,
    scopes: typeof v.scopes === 'string' && v.scopes ? v.scopes : 'openid email profile',
  };
  if (typeof v.displayName === 'string' && v.displayName) oidc.displayName = v.displayName;
  if (v.icon === 'github' || v.icon === 'key') oidc.icon = v.icon;
  return oidc;
}

/**
 * The configuration a request sees: every environment variable that is set
 * wins, as a whole group (OIDC, GitHub sign-in, webhook secret, editor URL);
 * otherwise the admin console's setting applies. In broker mode the stored
 * GitHub App is ignored: the hosting provider owns GitHub.
 */
export function effectiveConfig(env: ServerConfig, snapshot: SettingsSnapshot): ServerConfig {
  const config: ServerConfig = { ...env };
  if (!env.oidc) {
    const oidc = storedOidc(snapshot);
    if (oidc) config.oidc = oidc;
  }
  const app = env.broker || env.github ? null : storedGitHubApp(snapshot);
  if (!env.githubOAuth && app?.clientId && app.clientSecret) {
    if (settingFlag(snapshot, SETTING.signIn, 'github', true))
      config.githubOAuth = {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        webUrl: app.webUrl,
        apiUrl: app.apiUrl,
      };
  }
  if (!env.webhookSecret && app?.webhookSecret) config.webhookSecret = app.webhookSecret;
  if (!env.editorUrl) {
    const url = settingString(snapshot, SETTING.editor, 'url');
    if (url) {
      try {
        config.editorUrl = new URL(url).origin;
      } catch {
        // ignore an unparseable stored URL
      }
    }
  }
  config.editLinks = settingFlag(snapshot, SETTING.editor, 'editLinks', true);
  if (!env.sourceLinks && settingFlag(snapshot, SETTING.editor, 'sourceLinks', false))
    config.sourceLinks = true;
  // Demo readers only ever where the environment allows them (never in production).
  config.devLogin = env.devLogin && settingFlag(snapshot, SETTING.signIn, 'devLogin', true);
  return config;
}

/** Where each group of settings comes from, for the admin console's labels. */
export function settingSources(env: ServerConfig, snapshot: SettingsSnapshot) {
  const app = storedGitHubApp(snapshot);
  const source = (fromEnv: boolean, stored: boolean): SettingSource =>
    fromEnv ? 'env' : stored ? 'console' : 'none';
  return {
    oidc: source(Boolean(env.oidc), storedOidc(snapshot) !== null),
    github: env.github
      ? ('env' as const)
      : env.broker
        ? ('broker' as const)
        : app
          ? ('console' as const)
          : ('none' as const),
    githubSignIn: env.githubOAuth
      ? ('env' as const)
      : env.broker || env.github
        ? ('none' as const)
        : source(false, Boolean(app?.clientId && app.clientSecret)),
    webhook: source(Boolean(env.webhookSecret), Boolean(app?.webhookSecret)),
    editorUrl: source(
      Boolean(env.editorUrl),
      Boolean(settingString(snapshot, SETTING.editor, 'url')),
    ),
  };
}
