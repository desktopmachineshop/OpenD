import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { topicPageId } from '@opend/dita';
import { encodePath } from '@opend/render-html';
import {
  createEditorPreview,
  getActiveEditorBranch,
  getEditorPreview,
  listEditorAudit,
  listOrgs,
  recordEditorAudit,
  type EditorBranch,
} from '@opend/store';
import { requireEditor, wantsJson, type SignedIn } from './auth.js';
import type { EditorContext } from './context.js';
import {
  ASSET_HEADERS,
  PAGE_HEADERS,
  PREVIEW_HEADERS,
  csrfField,
  diagnosticsList,
  fileTree,
  h,
  layout,
  type Shell,
} from './pages.js';
import { banner, renderPreview, type PreviewAudience } from './preview.js';
import {
  EditorError,
  checkEditablePath,
  isEditable,
  type Choice,
  type DraftBuild,
  type RepoContext,
  type SyncResult,
} from './service.js';
import { TOPIC_TYPES, topicTemplate, type TopicType } from './templates.js';

const PREVIEW_MINUTES = 30;

type Body = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function page(reply: FastifyReply, html: string, status = 200) {
  return reply.code(status).headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(html);
}

function shellFor(
  editor: SignedIn,
  rc: RepoContext,
  title: string,
  current?: Shell['current'],
): Shell {
  return {
    title,
    user: editor.user,
    csrf: editor.csrf,
    repo: rc.repo.fullName,
    base: rc.baseBranch,
    current,
  };
}

/** Preview URL of a file in a build: its page when it is a published topic, else the index. */
function previewPath(draft: DraftBuild, path: string): string {
  const id = topicPageId(path);
  return draft.result.release?.topics[id] ? `${encodePath(id)}.html` : '';
}

function statusPanel(
  rc: RepoContext,
  branch: EditorBranch | null,
  sync: SyncResult | null,
): string {
  const conflict =
    sync?.status === 'conflict'
      ? `<p class="ed-alert" role="alert">The ${h(rc.baseBranch)} branch has changes that conflict with yours. <a href="/conflicts">Resolve the conflicts</a></p>`
      : '';
  if (!branch)
    return `<section class="ed-status" aria-label="Working branch"><p>You have no working branch yet. Your first save creates one, based on <code>${h(rc.baseBranch)}</code>.</p></section>`;
  const pr = branch.prNumber
    ? ` Pull request <a href="/publish">#${branch.prNumber}</a> is open: each save updates it.`
    : ' Nothing is published until you choose <a href="/publish">Publish</a>.';
  return `<section class="ed-status" aria-label="Working branch">${conflict}<p>Your working branch: <code>${h(branch.branch)}</code>.${pr}</p></section>`;
}

/** The active branch, merged with the base branch when the author opens a page. */
async function openBranch(
  ctx: EditorContext,
  rc: RepoContext,
  editor: SignedIn,
): Promise<{ branch: EditorBranch | null; sync: SyncResult | null }> {
  const branch = await ctx.service.activeBranch(rc, editor.user);
  if (!branch) return { branch, sync: null };
  return { branch, sync: await ctx.service.sync(rc, editor, branch) };
}

function insertTopicref(mapSource: string, href: string): string {
  const close = mapSource.lastIndexOf('</map>');
  if (close === -1)
    throw new EditorError(400, 'That map has no closing </map> tag to add the topic before.');
  return `${mapSource.slice(0, close)}  <topicref href="${h(href)}"/>\n${mapSource.slice(close)}`;
}

function parseChoices(body: Body): Choice[] {
  const choices: Choice[] = [];
  for (let i = 0; typeof body[`path.${i}`] === 'string'; i++) {
    const path = str(body[`path.${i}`]);
    const take = str(body[`take.${i}`]);
    if (take === 'mine') choices.push({ path, take });
    else if (take === 'theirs') choices.push({ path, take });
    else if (take === 'manual') choices.push({ path, take, content: str(body[`content.${i}`]) });
  }
  if (Array.isArray(body.choices)) {
    for (const c of body.choices as Body[]) {
      const take = str(c.take);
      if (take === 'manual') choices.push({ path: str(c.path), take, content: str(c.content) });
      else if (take === 'mine') choices.push({ path: str(c.path), take });
      else if (take === 'theirs') choices.push({ path: str(c.path), take });
    }
  }
  return choices;
}

export function registerRoutes(app: FastifyInstance, ctx: EditorContext): void {
  // ---- home: files, branch, new topic, preview as an org --------------------
  app.get('/', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const rc = await ctx.repoContext();
    const { branch, sync } = await openBranch(ctx, rc, editor);
    const head = await ctx.service.workingHead(rc, branch);
    const files = await ctx.service.docsFiles(rc, head);
    const editable = [...files.keys()].filter(isEditable);
    const changed = new Set<string>();
    if (branch) {
      for (const f of (await rc.gh.compare(rc.baseBranch, branch.branch)).files)
        if (f.path.startsWith(rc.docsPrefix)) changed.add(f.path.slice(rc.docsPrefix.length));
    }
    const draft = await ctx.service.build(rc, head);
    const errors = draft.diagnostics.filter((d) => d.severity === 'error').length;
    const maps = editable.filter((p) => p.endsWith('.ditamap'));
    const rootMap = draft.result.config?.map;
    const dirs = [
      ...new Set(editable.filter((p) => p.endsWith('.dita')).map((p) => posix.dirname(p))),
    ].sort();
    const orgs = (await listOrgs(ctx.pool)).filter((o) => o.version);
    const query = request.query as { saved?: string; resolved?: string; published?: string };
    const notice = query.resolved
      ? `<p class="ed-notice" role="status">Conflicts resolved in commit <code>${h(query.resolved.slice(0, 7))}</code>.</p>`
      : '';
    const body = `<h1>Files</h1>
${notice}${statusPanel(rc, branch, sync)}
<div class="ed-columns">
<section aria-labelledby="files-h"><h2 id="files-h">DITA files</h2>${fileTree(editable, null, changed)}
<p><a href="/preview/saved/">Preview ${branch ? 'your branch' : rc.baseBranch}</a> · ${errors ? `<a href="/preview/saved/">${errors} validation error${errors === 1 ? '' : 's'}</a>` : 'no validation errors'}</p></section>
<div>
<section aria-labelledby="new-h" class="ed-card"><h2 id="new-h">New topic</h2>
<form method="post" action="/new">${csrfField(editor.csrf)}
<p><label for="new-title">Title</label><input id="new-title" name="title" required maxlength="200"></p>
<p><label for="new-name">File name</label><input id="new-name" name="name" required pattern="[a-z0-9][a-z0-9-]*" maxlength="80" aria-describedby="new-name-hint"> <span id="new-name-hint" class="ed-hint">lowercase letters, digits and dashes; .dita is added</span></p>
<p><label for="new-dir">Folder</label><select id="new-dir" name="dir">${(dirs.length ? dirs : ['topics']).map((d) => `<option${d === 'topics' ? ' selected' : ''}>${h(d)}</option>`).join('')}</select></p>
<p><label for="new-type">Type</label><select id="new-type" name="type">${TOPIC_TYPES.map((t) => `<option value="${t.type}">${h(t.label)}</option>`).join('')}</select></p>
<p><label for="new-map">Add to navigation</label><select id="new-map" name="map"><option value="">Not yet</option>${maps.map((m) => `<option${m === rootMap ? ' selected' : ''}>${h(m)}</option>`).join('')}</select></p>
<p><button type="submit">Create topic</button></p>
</form></section>
<section aria-labelledby="as-h" class="ed-card"><h2 id="as-h">Preview as an org</h2>
<p class="ed-hint">See ${branch ? 'your branch' : rc.baseBranch} as a customer org sees it, with their entitlements. The preview link expires after ${PREVIEW_MINUTES} minutes and is logged.</p>
<form method="post" action="/preview-as">${csrfField(editor.csrf)}
<p><label for="as-org">Org</label><select id="as-org" name="org" required>${orgs.map((o) => `<option value="${h(o.slug)}">${h(o.name)} (${h(o.slug)})</option>`).join('')}</select></p>
<p><button type="submit"${orgs.length ? '' : ' disabled'}>Preview</button></p>
</form></section>
</div>
</div>`;
    return page(reply, layout(shellFor(editor, rc, 'Files', 'files'), body));
  });

  // ---- edit one file ---------------------------------------------------------
  app.get('/edit', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const query = request.query as { path?: string; saved?: string };
    const path = checkEditablePath(str(query.path));
    const rc = await ctx.repoContext();
    const { branch, sync } = await openBranch(ctx, rc, editor);
    const head = await ctx.service.workingHead(rc, branch);
    const file = await ctx.service.readFile(rc, head, path);
    if (!file)
      throw new EditorError(
        404,
        `${path} does not exist on ${branch ? 'your branch' : rc.baseBranch}.`,
      );
    const draft = await ctx.service.build(rc, head);
    ctx.drafts.delete(editor.sessionId);
    const files = await ctx.service.docsFiles(rc, head);
    const orgs = (await listOrgs(ctx.pool)).filter((o) => o.version);
    const target = previewPath(draft, path);
    const saved = query.saved
      ? `<p class="ed-notice" role="status">Saved as commit <code>${h(query.saved.slice(0, 7))}</code>.</p>`
      : '';
    const body = `<h1 class="ed-file">${h(path)}</h1>
${saved}${statusPanel(rc, branch, sync)}
<div class="ed-workspace">
${fileTree([...files.keys()].filter(isEditable), path, new Set())}
<section class="ed-source" aria-labelledby="source-label">
<form id="ed-form" method="post" action="/save" data-path="${h(path)}">
${csrfField(editor.csrf)}
<input type="hidden" name="path" value="${h(path)}">
<input type="hidden" name="branch" value="${h(branch?.branch ?? '')}">
<input type="hidden" name="expectSha" value="${h(file.sha)}">
<label id="source-label" for="ed-source">DITA source</label>
<textarea id="ed-source" name="content" spellcheck="false" autocapitalize="off" autocomplete="off" rows="30" aria-describedby="ed-diagnostics-h">${h(file.text)}</textarea>
<p><label for="ed-message">Note about this change (optional)</label><input id="ed-message" name="message" maxlength="200"></p>
<p class="ed-actions"><button type="submit">Save</button> <span id="ed-save-status" role="status" aria-live="polite"></span></p>
</form>
<section aria-labelledby="ed-diagnostics-h"><h2 id="ed-diagnostics-h">Problems</h2><div id="ed-diagnostics" aria-live="polite">${diagnosticsList(draft.diagnostics, path)}</div></section>
</section>
<section class="ed-preview" aria-labelledby="preview-h"><h2 id="preview-h">Preview <span class="ed-hint">(staff view: everything shown, conditions marked)</span></h2>
<iframe id="ed-preview" title="Preview of ${h(path)}" src="/preview/saved/${h(target)}"></iframe>
<form method="post" action="/preview-as" class="ed-inline">${csrfField(editor.csrf)}<input type="hidden" name="page" value="${h(target)}">
<label for="as-org">Preview this page as</label> <select id="as-org" name="org">${orgs.map((o) => `<option value="${h(o.slug)}">${h(o.name)}</option>`).join('')}</select> <button type="submit"${orgs.length ? '' : ' disabled'}>Open</button></form>
</section>
</div>`;
    return page(reply, layout(shellFor(editor, rc, path, 'files'), body));
  });

  // ---- save -------------------------------------------------------------------
  app.post('/save', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const rc = await ctx.repoContext();
    const path = checkEditablePath(str(body.path));
    const input: Parameters<typeof ctx.service.save>[2] = {
      branch: str(body.branch) || null,
      files: [{ path, content: str(body.content) }],
      message: str(body.message),
    };
    if (typeof body.expectSha === 'string') input.expectSha = body.expectSha;
    const result = await ctx.service.save(rc, editor, input);
    ctx.drafts.delete(editor.sessionId);
    if (!wantsJson(request)) {
      if (result.sync.status === 'conflict') return reply.redirect('/conflicts');
      return reply.redirect(`/edit?path=${encodeURIComponent(path)}&saved=${result.sha}`);
    }
    const draft = await ctx.service.build(rc, result.sha);
    const file = await ctx.service.readFile(rc, result.sha, path);
    return reply.send({
      sha: result.sha,
      branch: result.branch.branch,
      fileSha: file?.sha ?? null,
      sync: result.sync.status,
      diagnostics: result.diagnostics,
      previewUrl: `/preview/saved/${previewPath(draft, path)}?v=${result.sha.slice(0, 7)}`,
    });
  });

  // ---- live draft preview of unsaved text ----------------------------------------
  app.post('/api/preview', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const path = checkEditablePath(str(body.path));
    const rc = await ctx.repoContext();
    // Read the branch from the registry without the GitHub refresh: this runs as the author types.
    const branch = await getActiveEditorBranch(ctx.pool, rc.repo.id, editor.user.id);
    const head =
      (branch && (await rc.gh.branchSha(branch.branch))) ||
      (await ctx.service.workingHead(rc, null));
    const draft = await ctx.service.build(rc, head, new Map([[path, str(body.content)]]));
    ctx.drafts.set(editor.sessionId, draft);
    return reply.send({
      diagnostics: draft.diagnostics,
      errors: draft.diagnostics.filter((d) => d.severity === 'error').length,
      previewUrl: `/preview/draft/${previewPath(draft, path)}?v=${Date.now().toString(36)}`,
    });
  });

  // ---- new topic from a template -----------------------------------------------
  app.post('/new', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const name = str(body.name).trim();
    const title = str(body.title).trim();
    const type = (TOPIC_TYPES.find((t) => t.type === str(body.type))?.type ??
      'concept') as TopicType;
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name))
      throw new EditorError(400, 'Use lowercase letters, digits and dashes for the file name.');
    if (!title) throw new EditorError(400, 'Give the topic a title.');
    const dir =
      str(body.dir)
        .trim()
        .replace(/^\/+|\/+$/g, '') || 'topics';
    const path = checkEditablePath(`${dir}/${name}.dita`);
    const rc = await ctx.repoContext();
    const branch = await ctx.service.activeBranch(rc, editor.user);
    const head = await ctx.service.workingHead(rc, branch);
    const files = await ctx.service.docsFiles(rc, head);
    if (files.has(path)) throw new EditorError(409, `${path} already exists.`);
    const changes = [{ path, content: topicTemplate(type, name, title) }];
    const map = str(body.map);
    if (map) {
      if (!files.has(map) || !map.endsWith('.ditamap'))
        throw new EditorError(400, `There is no map ${map}.`);
      const source = (await ctx.service.readFile(rc, head, map))!.text;
      changes.push({
        path: map,
        content: insertTopicref(source, posix.relative(posix.dirname(map), path)),
      });
    }
    const result = await ctx.service.save(rc, editor, {
      branch: branch?.branch ?? null,
      files: changes,
      message: `Add ${type} topic ${path}`,
    });
    if (wantsJson(request))
      return reply.send({ path, sha: result.sha, branch: result.branch.branch });
    if (result.sync.status === 'conflict') return reply.redirect('/conflicts');
    return reply.redirect(`/edit?path=${encodeURIComponent(path)}&saved=${result.sha}`);
  });

  // ---- conflicts with the base branch -------------------------------------------
  app.get('/conflicts', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const rc = await ctx.repoContext();
    const shell = shellFor(editor, rc, 'Conflicts', 'conflicts');
    const branch = await ctx.service.activeBranch(rc, editor.user);
    if (!branch)
      return page(reply, layout(shell, '<h1>No conflicts</h1><p>You have no working branch.</p>'));
    const sync = await ctx.service.sync(rc, editor, branch);
    if (sync.status !== 'conflict')
      return page(
        reply,
        layout(
          shell,
          `<h1>No conflicts</h1><p>Your branch is up to date with ${h(rc.baseBranch)}. <a href="/">Back to files</a></p>`,
        ),
      );
    const set = await ctx.service.conflicts(rc, branch);
    let body = `<h1>Changes on ${h(rc.baseBranch)} conflict with yours</h1>
<p>Someone changed the same files on <code>${h(rc.baseBranch)}</code> since you started. For each file, choose which version to keep, or edit it by hand. Your choice is saved to your branch as a merge; nothing is published.</p>`;
    if (set.structural.length) {
      body += `<section class="ed-alert" role="alert" aria-labelledby="structural-h"><h2 id="structural-h">A developer needs to resolve this</h2>
<p>These changes cannot be resolved by choosing a version, so a developer must resolve them in the pull request:</p>
<ul>${set.structural.map((s) => `<li><code>${h(s.path)}</code>: ${h(s.reason)}</li>`).join('')}</ul>
<form method="post" action="/escalate">${csrfField(editor.csrf)}<button type="submit">Ask a developer (open the pull request)</button></form>
${branch.prNumber ? `<p>Pull request <a href="/publish">#${branch.prNumber}</a>.</p>` : ''}</section>`;
      return page(reply, layout(shell, body));
    }
    const sections = set.conflicts
      .map(
        (c, i) => `<fieldset class="ed-conflict"><legend><code>${h(c.path)}</code></legend>
<input type="hidden" name="path.${i}" value="${h(c.path)}">
<div class="ed-sides">
<figure><figcaption>Your version</figcaption><pre tabindex="0">${h(c.mine)}</pre></figure>
<figure><figcaption>Current version on ${h(rc.baseBranch)}</figcaption><pre tabindex="0">${h(c.theirs)}</pre></figure>
</div>
<p><label><input type="radio" name="take.${i}" value="mine" required> Keep your version</label>
<label><input type="radio" name="take.${i}" value="theirs"> Keep the current version</label>
<label><input type="radio" name="take.${i}" value="manual"> Edit by hand</label></p>
<p><label for="content-${i}">Hand-edited version (used with "Edit by hand"; remove the &lt;&lt;&lt;&lt;&lt;&lt;&lt; ======= &gt;&gt;&gt;&gt;&gt;&gt;&gt; lines)</label>
<textarea id="content-${i}" name="content.${i}" rows="12" spellcheck="false">${h(c.merged)}</textarea></p>
</fieldset>`,
      )
      .join('');
    body += `<form method="post" action="/conflicts/resolve">${csrfField(editor.csrf)}
<input type="hidden" name="branch" value="${h(branch.branch)}">
<input type="hidden" name="oursSha" value="${h(set.oursSha)}">
<input type="hidden" name="theirsSha" value="${h(set.theirsSha)}">
${sections}
${set.automatic.length ? `<p class="ed-hint">${set.automatic.length} other file${set.automatic.length === 1 ? '' : 's'} merged without conflicts.</p>` : ''}
<p><button type="submit">Save my choices</button></p></form>`;
    return page(reply, layout(shell, body));
  });

  app.post('/conflicts/resolve', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const rc = await ctx.repoContext();
    const branch = await ctx.service.ownBranch(rc, editor.user, str(body.branch));
    const sha = await ctx.service.resolve(rc, editor, branch, {
      oursSha: str(body.oursSha),
      theirsSha: str(body.theirsSha),
      choices: parseChoices(body),
    });
    if (wantsJson(request)) return reply.send({ sha });
    return reply.redirect(`/?resolved=${sha}`);
  });

  app.post('/escalate', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const rc = await ctx.repoContext();
    const branch = await ctx.service.activeBranch(rc, editor.user);
    if (!branch) throw new EditorError(400, 'You have no working branch.');
    const pull = await ctx.service.escalate(rc, editor, branch);
    if (wantsJson(request)) return reply.send({ pr: pull.number, url: pull.url });
    return reply.redirect('/publish');
  });

  // ---- publish ------------------------------------------------------------------
  app.get('/publish', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const rc = await ctx.repoContext();
    const { branch, sync } = await openBranch(ctx, rc, editor);
    const { pull, review } = await ctx.service.reviewState(rc, branch);
    const req = review.requirements;
    const query = request.query as { done?: string; error?: string };
    const files = branch
      ? (await rc.gh.compare(rc.baseBranch, branch.branch)).files.map((f) => f.path)
      : [];
    const head = await ctx.service.workingHead(rc, branch);
    const draft = await ctx.service.build(rc, head);
    const errors = draft.diagnostics.filter((d) => d.severity === 'error');
    const rules: string[] = [];
    if (req.requiredApprovals)
      rules.push(
        `${req.requiredApprovals} approving review${req.requiredApprovals === 1 ? '' : 's'}`,
      );
    if (req.codeOwnerReview) rules.push('a review from a code owner');
    for (const c of req.requiredChecks) rules.push(`the check <code>${h(c)}</code> to pass`);
    const rulesHtml = `<section aria-labelledby="rules-h" class="ed-card"><h2 id="rules-h">What publishing needs</h2>
${req.known && !rules.length ? `<p>No review rules apply to <code>${h(rc.baseBranch)}</code>: publishing merges your changes straight away.</p>` : ''}
${rules.length ? `<p>Changes to <code>${h(rc.baseBranch)}</code> need ${rules.join(', ')} (from ${h(req.sources.join(' and '))}).</p>` : ''}
${req.notes.map((n) => `<p class="ed-alert">${h(n)}</p>`).join('')}</section>`;
    let notice = '';
    if (query.done === 'merged')
      notice =
        '<p class="ed-notice" role="status">Published: your changes are merged and will go live after the build.</p>';
    else if (query.done === 'opened' || query.done === 'updated')
      notice = `<p class="ed-notice" role="status">Pull request ${query.done === 'opened' ? 'opened' : 'updated'}.${query.error ? ` GitHub did not merge it: ${h(query.error)}` : ''}</p>`;
    const changes = review.changesRequestedBy.length
      ? `<p class="ed-alert" role="alert">Changes requested by ${h(review.changesRequestedBy.join(', '))}. Keep editing on your branch: each save updates the pull request. Publish again when you are done.</p>`
      : '';
    const prHtml = pull
      ? `<section aria-labelledby="pr-h" class="ed-card"><h2 id="pr-h">Pull request <a href="${h(pull.url)}">#${pull.number}</a></h2>
${changes}
<p>Approved by: ${review.approvedBy.length ? h(review.approvedBy.join(', ')) : 'nobody yet'}.</p>
${review.checks.length ? `<table><caption>Checks</caption><thead><tr><th scope="col">Check</th><th scope="col">State</th></tr></thead><tbody>${review.checks.map((c) => `<tr><td>${h(c.context)}</td><td>${h(c.state)}</td></tr>`).join('')}</tbody></table>` : ''}
${review.blockers.length ? `<h3>Still blocking the merge</h3><ul>${review.blockers.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : '<p>Nothing blocks the merge.</p>'}
</section>`
      : '';
    const canPublish = branch && files.length > 0 && !errors.length && sync?.status !== 'conflict';
    const action = !branch
      ? '<p>You have no changes to publish. Edit a file and save first.</p>'
      : sync?.status === 'conflict'
        ? `<p class="ed-alert">Resolve the <a href="/conflicts">conflicts with ${h(rc.baseBranch)}</a> before publishing.</p>`
        : errors.length
          ? `<p class="ed-alert">Fix the ${errors.length} validation error${errors.length === 1 ? '' : 's'} before publishing.</p>${diagnosticsList(errors)}`
          : files.length === 0
            ? '<p>Your branch has no changes yet.</p>'
            : '';
    const body = `<h1>Publish</h1>
${notice}${statusPanel(rc, branch, sync)}
${rulesHtml}
${files.length ? `<section aria-labelledby="files-h" class="ed-card"><h2 id="files-h">Your changes</h2><ul>${files.map((f) => `<li><code>${h(f)}</code></li>`).join('')}</ul></section>` : ''}
${prHtml}
${action}
${canPublish ? `<form method="post" action="/publish">${csrfField(editor.csrf)}<input type="hidden" name="branch" value="${h(branch.branch)}"><button type="submit">${pull ? 'Update and publish' : 'Publish'}</button></form>` : ''}`;
    return page(reply, layout(shellFor(editor, rc, 'Publish', 'publish'), body));
  });

  app.post('/publish', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const rc = await ctx.repoContext();
    const branch = str(body.branch)
      ? await ctx.service.ownBranch(rc, editor.user, str(body.branch))
      : await ctx.service.activeBranch(rc, editor.user);
    if (!branch) throw new EditorError(400, 'You have no changes to publish.');
    const outcome = await ctx.service.publish(rc, editor, branch);
    if (wantsJson(request))
      return reply.send({
        pr: outcome.pull.number,
        url: outcome.pull.url,
        created: outcome.created,
        merged: outcome.merged,
        mergeSha: outcome.mergeSha ?? null,
        blockers: outcome.review.blockers,
        mergeError: outcome.mergeError ?? null,
      });
    const done = outcome.merged ? 'merged' : outcome.created ? 'opened' : 'updated';
    const error = outcome.mergeError ? `&error=${encodeURIComponent(outcome.mergeError)}` : '';
    return reply.redirect(`/publish?done=${done}${error}`);
  });

  // ---- activity (the editor audit trail, for the signed-in author) ------------------
  app.get('/activity', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const rc = await ctx.repoContext();
    const rows = await listEditorAudit(ctx.pool, { userId: editor.user.id, limit: 200 });
    const body = `<h1>Your activity</h1>
<table class="ed-table"><thead><tr><th scope="col">When (UTC)</th><th scope="col">Action</th><th scope="col">Branch</th><th scope="col">Commit</th><th scope="col">Pull request</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${h(r.at.toISOString().replace('T', ' ').slice(0, 19))}</td><td>${h(r.action)}</td><td>${h(r.branch ?? '')}</td><td>${r.commitSha ? `<code>${h(r.commitSha.slice(0, 7))}</code>` : ''}</td><td>${r.prNumber ? `#${r.prNumber}` : ''}</td></tr>`).join('')}
</tbody></table>`;
    return page(reply, layout(shellFor(editor, rc, 'Activity', 'activity'), body));
  });

  // ---- staff preview as an org --------------------------------------------------
  app.post('/preview-as', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const body = (request.body ?? {}) as Body;
    const rc = await ctx.repoContext();
    const org = (await listOrgs(ctx.pool)).find((o) => o.slug === str(body.org));
    if (!org || !org.version) throw new EditorError(400, 'Choose an org that has entitlements.');
    const branch = await getActiveEditorBranch(ctx.pool, rc.repo.id, editor.user.id);
    const head =
      (branch && (await rc.gh.branchSha(branch.branch))) ||
      (await ctx.service.workingHead(rc, null));
    const preview = await createEditorPreview(ctx.pool, {
      userId: editor.user.id,
      sessionId: editor.sessionId,
      repoId: rc.repo.id,
      orgSlug: org.slug,
      context: {
        org: org.slug,
        products: org.products,
        features: org.features,
        version: org.version,
      },
      commitSha: head,
      minutes: PREVIEW_MINUTES,
    });
    await recordEditorAudit(ctx.pool, {
      sessionId: editor.sessionId,
      userId: editor.user.id,
      repoId: rc.repo.id,
      branch: branch?.branch ?? rc.baseBranch,
      action: 'preview_as',
      commitSha: head,
      detail: { org: org.slug, preview: preview.id, expiresAt: preview.expiresAt.toISOString() },
    });
    const target = str(body.page);
    const rest = /^[A-Za-z0-9._/%-]*\.html$/.test(target) && !target.includes('..') ? target : '';
    const url = `/preview/as/${preview.id}/${rest}`;
    if (wantsJson(request))
      return reply.send({ id: preview.id, url, expiresAt: preview.expiresAt });
    return reply.redirect(url);
  });

  const sendPreview = async (
    reply: FastifyReply,
    rc: RepoContext,
    draft: DraftBuild,
    rest: string,
    base: string,
    audience: PreviewAudience,
  ) => {
    const res = await renderPreview(ctx.service, rc, draft, rest, base, audience);
    return reply
      .code(res.status)
      .headers(res.asset ? ASSET_HEADERS : PREVIEW_HEADERS)
      .type(res.type)
      .send(res.body);
  };

  app.get('/preview/as/:id/*', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const params = request.params as { id: string; '*': string };
    const preview = await getEditorPreview(ctx.pool, params.id);
    // Previews belong to the person who opened them.
    if (!preview || preview.userId !== editor.user.id)
      throw new EditorError(404, 'No such preview.');
    if (preview.expiresAt.getTime() <= Date.now())
      throw new EditorError(410, 'This preview has expired. Open a new one from the editor.');
    const rc = await ctx.repoContext();
    const draft = await ctx.service.build(rc, preview.commitSha);
    const c = preview.context;
    const until = preview.expiresAt.toISOString().slice(11, 16);
    return sendPreview(reply, rc, draft, params['*'], `/preview/as/${preview.id}/`, {
      reader: c,
      banner: banner(
        `Previewing commit ${preview.commitSha.slice(0, 7)} as ${preview.orgSlug}: products ${c.products.join(', ') || 'none'}, features ${c.features.join(', ') || 'none'}, version ${c.version}. Expires ${until} UTC; this preview is logged.`,
        'org',
      ),
    });
  });

  app.get('/preview/:mode', async (request, reply) =>
    reply.redirect(`/preview/${encodeURIComponent((request.params as { mode: string }).mode)}/`),
  );

  app.get('/preview/:mode/*', async (request, reply) => {
    const editor = await requireEditor(request, reply, ctx);
    if (!editor) return;
    const params = request.params as { mode: string; '*': string };
    const rc = await ctx.repoContext();
    let draft: DraftBuild;
    let text: string;
    if (params.mode === 'main') {
      draft = await ctx.service.build(rc, await ctx.service.workingHead(rc, null));
      text = `The current ${rc.baseBranch} branch. Staff view: everything is shown and conditions are marked.`;
    } else if (params.mode === 'saved' || params.mode === 'draft') {
      const unsaved = params.mode === 'draft' ? ctx.drafts.get(editor.sessionId) : undefined;
      if (unsaved) {
        draft = unsaved;
        text =
          'Draft with your unsaved changes. Staff view: everything is shown and conditions are marked.';
      } else {
        const branch = await getActiveEditorBranch(ctx.pool, rc.repo.id, editor.user.id);
        const head =
          (branch && (await rc.gh.branchSha(branch.branch))) ||
          (await ctx.service.workingHead(rc, null));
        draft = await ctx.service.build(rc, head);
        text = `${branch ? 'Your saved branch' : `The ${rc.baseBranch} branch`}. Staff view: everything is shown and conditions are marked.`;
      }
    } else throw new EditorError(404, 'No such preview.');
    return sendPreview(reply, rc, draft, params['*'], `/preview/${params.mode}/`, {
      reader: null,
      banner: banner(text),
    });
  });
}
