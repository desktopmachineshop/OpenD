import { LRUCache } from 'lru-cache';
import { findRepoByName, listRepos, type Pool, type Repo } from '@opend/store';
import type { Log } from '@opend/worker';
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
  githubOAuth: GitHubOAuth | null;
  /** The GitHub client for a repository (the App installation's REST client in production). */
  clientFor: (repo: Repo & { installationId: number }) => GitHubClient;
  /** Each session's latest unsaved draft build, for the draft preview. */
  drafts: LRUCache<string, DraftBuild>;
  /** The repository being edited, resolved from the repos table and cached briefly. */
  repoContext(): Promise<RepoContext>;
}

export function repoResolver(
  config: EditorConfig,
  pool: Pool,
  clientFor: EditorContext['clientFor'],
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
    if (repo.installationId === null)
      throw new EditorError(
        503,
        `${repo.fullName} has no GitHub App installation; the editor commits through the App.`,
      );
    const rc: RepoContext = {
      repo,
      gh: clientFor({ ...repo, installationId: repo.installationId }),
      baseBranch: config.baseBranch,
      docsPrefix: docsPrefix(repo.docsPath),
    };
    cached = { at: Date.now(), rc };
    return rc;
  };
}
