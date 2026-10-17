import {
  deleteEditorGitHubTokens,
  getEditorGitHubToken,
  purgeEditorGitHubTokens,
  putEditorGitHubToken,
  withTransaction,
  type EditorGitHubToken,
  type GitHubUserGrant,
  type Pool,
  type SecretBox,
} from '@opend/store';
import type { Log } from '@opend/worker';
import { EditorError } from './errors.js';
import type { GitHubOAuth } from './github/oauth.js';
import { SIGN_IN_AGAIN, type UserTokenSource } from './github/user.js';

/** Refresh a little before GitHub's eight hours are up. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * The GitHub user access tokens of editor sessions, sealed in
 * `editor_github_tokens` with the settings secret key. Tokens are kept only
 * when a key is configured; they never leave the server.
 */
export class EditorTokens {
  constructor(
    private readonly pool: Pool,
    private readonly box: () => SecretBox | null,
    private readonly oauth: () => GitHubOAuth | null,
    private readonly log: Log,
  ) {}

  /** Whether tokens can be stored (a secret key is configured). */
  get canStore(): boolean {
    return this.box() !== null;
  }

  /** Keeps a session's token. Returns false when there is no key to seal it with. */
  async save(
    session: { sessionId: string; userId: number },
    github: { id: number; login: string },
    grant: GitHubUserGrant,
  ): Promise<boolean> {
    const box = this.box();
    if (!box) return false;
    await purgeEditorGitHubTokens(this.pool);
    await putEditorGitHubToken(this.pool, box, {
      sessionId: session.sessionId,
      userId: session.userId,
      githubId: github.id,
      githubLogin: github.login,
      grant,
    });
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    await deleteEditorGitHubTokens(this.pool, { sessionId });
  }

  /** The session's token as a source for GitHub calls, or null when it has none. */
  async forSession(sessionId: string): Promise<UserTokenSource | null> {
    const box = this.box();
    if (!box) return null;
    const stored = await getEditorGitHubToken(this.pool, box, sessionId);
    if (!stored) return null;
    let current: EditorGitHubToken = stored;
    return {
      login: stored.githubLogin,
      githubId: stored.githubId,
      token: async () => {
        if (!expiring(current)) return current.accessToken;
        current = await this.refresh(box, sessionId);
        return current.accessToken;
      },
      revoked: async () => {
        this.log({ level: 'info', msg: 'github user token refused', github: stored.githubLogin });
        await this.delete(sessionId);
      },
    };
  }

  /**
   * Refreshes an expiring token. One refresh per session at a time across
   * processes (an advisory lock): GitHub invalidates a refresh token once used.
   */
  private async refresh(box: SecretBox, sessionId: string): Promise<EditorGitHubToken> {
    type Outcome = { token: EditorGitHubToken } | { error: 'missing' | 'expired' | 'refused' };
    const outcome = await withTransaction(this.pool, async (client): Promise<Outcome> => {
      await client.query("select pg_advisory_xact_lock(hashtext('opend-editor-token:' || $1))", [
        sessionId,
      ]);
      const fresh = await getEditorGitHubToken(client, box, sessionId);
      if (!fresh) return { error: 'missing' as const };
      if (!expiring(fresh)) return { token: fresh };
      const oauth = this.oauth();
      const usable =
        fresh.refreshToken &&
        (!fresh.refreshExpiresAt || fresh.refreshExpiresAt.getTime() > Date.now());
      if (!oauth || !usable) return { error: 'expired' as const };
      let grant: GitHubUserGrant;
      try {
        grant = await oauth.refresh(fresh.refreshToken!);
      } catch (err) {
        this.log({ level: 'warn', msg: 'github token refresh failed', error: String(err) });
        return { error: 'refused' as const };
      }
      await putEditorGitHubToken(client, box, {
        sessionId,
        userId: fresh.userId,
        githubId: fresh.githubId,
        githubLogin: fresh.githubLogin,
        grant,
      });
      const saved = await getEditorGitHubToken(client, box, sessionId);
      return saved ? { token: saved } : { error: 'missing' as const };
    });
    if ('token' in outcome) return outcome.token;
    await this.delete(sessionId);
    throw new EditorError(401, SIGN_IN_AGAIN, { githubSignIn: true });
  }
}

function expiring(token: EditorGitHubToken): boolean {
  return token.expiresAt !== null && token.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
}
