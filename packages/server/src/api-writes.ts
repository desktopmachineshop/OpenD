import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  EditorError,
  EditorService,
  RestGitHubClient,
  checkEditablePath,
  docsPrefix,
  type Actor,
  type PullRequest,
  type RepoContext,
} from '@opend/editor';
import {
  audit,
  enqueueJob,
  getEditorUser,
  listJobs,
  setApiKeyEditorUser,
  upsertEditorUser,
  withTransaction,
  type ApiKey,
} from '@opend/store';
import { listRemoteRefs, releaseRefsToPoll } from '@opend/worker';
import { ApiError, requireRepo, type ApiHandle } from './api.js';
import type { AppContext } from './context.js';

/** Editor users made for API keys have addresses in this reserved domain (RFC 2606). */
export const API_KEY_EMAIL_DOMAIN = 'api-keys.opend.invalid';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 2_000_000;

/**
 * Changes through the API: the docs source, validation, saving to the key's
 * own working branch, and publishing it as a pull request. It is the web
 * editor's service (one branch per author, merge-never-rebase, the base
 * branch's review rules), with the key as the author. Builds too.
 */
export function registerApiWrites(app: FastifyInstance, ctx: AppContext, handle: ApiHandle): void {
  let service: EditorService | null = null;
  const editor = () => (service ??= new EditorService(ctx.pool));

  const repoContext = async (): Promise<RepoContext> => {
    const repo = await requireRepo(ctx);
    const mode = ctx.github.mode();
    if (mode === 'none' || (mode !== 'broker' && repo.installationId === null))
      throw new ApiError(503, 'GitHub is not connected: connect it in the admin console first');
    return {
      repo,
      gh: new RestGitHubClient(ctx.github, repo),
      baseBranch: baseBranch(repo.releaseRefs),
      docsPrefix: docsPrefix(repo.docsPath),
    };
  };

  /** The editor user a key's commits are made as, created on its first change. */
  const actorFor = async (key: ApiKey): Promise<Actor> => {
    let user = key.editorUserId ? await getEditorUser(ctx.pool, key.editorUserId) : null;
    if (!user) {
      user = await upsertEditorUser(ctx.pool, {
        email: `api-key-${key.id}@${API_KEY_EMAIL_DOMAIN}`,
        name: `${key.name} (API key)`,
      });
      await setApiKeyEditorUser(ctx.pool, key.id, user.id);
    }
    return { user, sessionId: `api-key:${key.id}` };
  };

  const editorCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof EditorError) throw new ApiError(err.status, err.message, err.detail);
      throw err;
    }
  };

  const headFor = async (rc: RepoContext, key: ApiKey, ref: unknown): Promise<string> => {
    if (ref === undefined || ref === 'base') return editor().workingHead(rc, null);
    if (ref !== 'working') throw new ApiError(400, 'ref must be base or working');
    const actor = await actorFor(key);
    return editor().workingHead(rc, await editor().activeBranch(rc, actor.user));
  };

  app.get(
    '/api/v1/source/files',
    handle('write', async ({ key }, request) =>
      editorCall(async () => {
        const rc = await repoContext();
        const head = await headFor(rc, key, (request.query as { ref?: unknown }).ref);
        const files = await editor().docsFiles(rc, head);
        return { commit: head, files: [...files].map(([path, sha]) => ({ path, sha })) };
      }),
    ),
  );

  app.get(
    '/api/v1/source/files/*',
    handle('write', async ({ key }, request) =>
      editorCall(async () => {
        const path = (request.params as { '*': string })['*'];
        const rc = await repoContext();
        const head = await headFor(rc, key, (request.query as { ref?: unknown }).ref);
        const file = await editor().readFile(rc, head, path);
        if (!file) throw new ApiError(404, 'no such file');
        return { path, sha: file.sha, commit: head, content: file.text };
      }),
    ),
  );

  app.post(
    '/api/v1/validate',
    handle('write', async ({ key }, request) =>
      editorCall(async () => {
        const files = filesOf(request);
        const rc = await repoContext();
        const head = await headFor(
          rc,
          key,
          (request.body as { ref?: unknown } | null)?.ref ?? 'working',
        );
        const draft = await editor().build(
          rc,
          head,
          new Map(files.map((f) => [f.path, f.content])),
        );
        const errors = draft.diagnostics.filter((d) => d.severity === 'error').length;
        return { commit: head, valid: errors === 0, diagnostics: draft.diagnostics };
      }),
    ),
  );

  app.get(
    '/api/v1/changes',
    handle('write', async ({ key }) =>
      editorCall(async () => {
        const rc = await repoContext();
        const actor = await actorFor(key);
        const branch = await editor().activeBranch(rc, actor.user);
        const { pull, review } = await editor().reviewState(rc, branch);
        return {
          branch: branch?.branch ?? null,
          head: branch ? await editor().workingHead(rc, branch) : null,
          pull: pullJson(pull),
          review,
        };
      }),
    ),
  );

  app.post(
    '/api/v1/changes',
    handle('write', async ({ key }, request) =>
      editorCall(async () => {
        const body = (request.body ?? {}) as { message?: unknown; expectSha?: unknown };
        const files = filesOf(request);
        const rc = await repoContext();
        const actor = await actorFor(key);
        const branch = await editor().activeBranch(rc, actor.user);
        const input: Parameters<EditorService['save']>[2] = {
          branch: branch?.branch ?? null,
          files,
          message: typeof body.message === 'string' ? body.message.slice(0, 200) : '',
        };
        if (typeof body.expectSha === 'string') input.expectSha = body.expectSha;
        const result = await editor().save(rc, actor, input);
        return {
          branch: result.branch.branch,
          commit: result.sha,
          sync: result.sync.status,
          valid: !result.diagnostics.some((d) => d.severity === 'error'),
          diagnostics: result.diagnostics,
        };
      }),
    ),
  );

  app.post(
    '/api/v1/changes/publish',
    handle('write', async ({ key }, request) =>
      editorCall(async () => {
        const wantsMerge = (request.body as { merge?: unknown } | null)?.merge === true;
        if (wantsMerge && !key.scopes.includes('publish'))
          throw new ApiError(
            403,
            'merging needs the publish scope; this key can open pull requests only',
          );
        const rc = await repoContext();
        const actor = await actorFor(key);
        const branch = await editor().activeBranch(rc, actor.user);
        if (!branch) throw new ApiError(409, 'nothing to publish: save changes first');
        const outcome = await editor().publish(rc, actor, branch, { merge: wantsMerge });
        return {
          pull: pullJson(outcome.pull),
          created: outcome.created,
          merged: outcome.merged,
          mergeCommit: outcome.mergeSha ?? null,
          mergeError: outcome.mergeError ?? null,
          review: outcome.review,
        };
      }),
    ),
  );

  app.get(
    '/api/v1/builds',
    handle('builds', async () => {
      const repo = await requireRepo(ctx);
      return { builds: await listJobs(ctx.pool, { repoId: repo.id, limit: 20 }) };
    }),
  );

  app.post(
    '/api/v1/builds',
    handle('builds', async ({ key }, request) => {
      const repo = await requireRepo(ctx);
      let refs;
      try {
        const token = await ctx.github.repoToken(repo, 'read');
        refs = releaseRefsToPoll(
          await listRemoteRefs(repo.sourceUrl, token, ctx.github.gitHosts),
          repo.releaseRefs,
        );
      } catch (err) {
        throw new ApiError(
          502,
          `could not read the repository’s branches: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const wanted = (request.body as { ref?: unknown } | null)?.ref;
      if (typeof wanted === 'string') refs = refs.filter((r) => r.ref === wanted);
      const jobs = await withTransaction(ctx.pool, async (db) => {
        const out = [];
        for (const { ref, sha } of refs) {
          const job = await enqueueJob(db, { repoId: repo.id, ref, sha });
          await audit(db, `api-key:${key.id}`, 'build.request', {
            repo: repo.fullName,
            ref,
            sha,
            job: job.id,
          });
          out.push(job);
        }
        return out;
      });
      return { queued: jobs };
    }),
  );
}

/** The branch the editor works against: the first release ref without a wildcard, else `main`. */
export function baseBranch(releaseRefs: readonly string[]): string {
  return releaseRefs.find((r) => !r.includes('*')) ?? 'main';
}

function filesOf(request: FastifyRequest): { path: string; content: string }[] {
  const files = (request.body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
    throw new ApiError(400, `files must be a list of 1 to ${MAX_FILES} { path, content }`);
  return files.map((f: unknown) => {
    const { path, content } = (f ?? {}) as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string')
      throw new ApiError(400, 'each file needs a path and content (strings)');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw new ApiError(413, `${path} is larger than ${MAX_FILE_BYTES} bytes`);
    try {
      return { path: checkEditablePath(path), content };
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
  });
}

function pullJson(pull: PullRequest | null) {
  return pull
    ? {
        number: pull.number,
        url: pull.url,
        state: pull.state,
        merged: pull.merged,
        title: pull.title,
      }
    : null;
}
