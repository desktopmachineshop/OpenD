import { LRUCache } from 'lru-cache';
import { findRepoByName, listRepos, type Pool, type Repo, type SettingsCache } from '@opend/store';
import type { GitHubConnection, Log } from '@opend/worker';
import type { EditorConfig } from './config.js';
import type { GitHubClient } from './github/client.js';
import type { GitHubOAuth } from './github/oauth.js';
import type { OidcProvider } from './oidc.js';
import {
  EditorError,
  docsPrefix,
  type DraftBuild,
  type EditorService,
  type RepoContext,
} from './service.js';

export interface EditorContext {
  config: EditorConfig;
  pool: Pool;
  log: Log;
  service: EditorService;
  oidc: OidcProvider | null;
  /** Author sign-in with GitHub: from the environment, or the app the admin console connected. */
  githubOAuth: GitHubOAuth | null;
  /** Installation tokens: the environment's App, the broker, or the connected app. */
  github: GitHubConnection;
  /** Settings shared with the docs site's admin console; null in tests that pass none. */
  settings: SettingsCache | null;
  /** The GitHub client for a repository (the installation's REST client in production). */
  clientFor: (repo: Repo) => GitHubClient;
  /** Each session's latest unsaved draft build, for the draft preview. */
  drafts: LRUCache<string, DraftBuild>;
  /** The repository being edited, resolved from the repos table and cached briefly. */
  repoContext(): Promise<RepoContext>;
}

export function repoResolver(
  config: EditorConfig,
  pool: Pool,
  clientFor: EditorContext['clientFor'],
  /** The broker mints tokens by repository name, so no installation id is needed. */
  needsInstallation: () => boolean = () => true,
): () => Promise<RepoContext> {
  let cached: { at: number; rc: RepoContext } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached.rc;
    let repo: Repo | null;
    if (config.repo) repo = await findRepoByName(pool, config.repo);
    else {
      const all = await listRepos(pool);
      repo = all.length === 1 ? all[0]! : null;
      if (all.length > 1)
        throw new EditorError(503, 'Several docs repositories are registered: set EDITOR_REPO.');
    }
    if (!repo) throw new EditorError(503, 'The docs repository is not registered yet.');
    if (repo.installationId === null && needsInstallation())
      throw new EditorError(
        503,
        `${repo.fullName} has no GitHub App installation; the editor commits through the App. Connect GitHub in the docs site's admin console.`,
      );
    const rc: RepoContext = {
      repo,
      gh: clientFor(repo),
      baseBranch: config.baseBranch,
      docsPrefix: docsPrefix(repo.docsPath),
    };
    cached = { at: Date.now(), rc };
    return rc;
  };
}
