# 0007 Web editor: save to a branch, publish through a pull request

- Status: accepted
- Date: 2026-10-16

## Context

Developers edit the docs repository in Git. Other authors (support, product, technical writers without Git) need a safe route into the same repository. The plan asks for:

- one source of truth and one publish path, so the editor must not become a second content store;
- saving and publishing as separate steps: save as often as you like, publish when ready;
- authors credited on their commits, even those without a GitHub account;
- the organisation's own review rules (branch protection) deciding what may merge;
- conflicts with changes on `main` that a non-developer can resolve.

The content is DITA XML, so a Markdown editor is out of scope.

## Decision

**A separate service on its own host.** `@opend/editor` is a Fastify app started with `opend-server editor serve` (same image as the other roles) or the standalone `opend-editor` binary. It runs on `EDITOR_PUBLIC_URL`, which the configuration refuses to share with the docs site (`PUBLIC_URL`). In production the host names must differ, because cookies ignore ports.

**A separate identity pool.**

- **Accounts:** editors live in `editor_users`, not `readers`, and are never derived from reader accounts.
- **Session cookie:** the cookie is `opend_editor_session`. It holds only a session id, is signed with `EDITOR_SESSION_SECRET` and is host-only. The id points at a row in `editor_sessions`, so signing out or disabling an editor revokes it at once.
- **No crossover:** a reader session never opens the editor, and an editor session grants nothing on the docs site.
- **Developers** sign in with GitHub (OAuth web flow). Anyone with write, maintain or admin permission on the docs repository gets an account on first sign-in. Others must be registered by their GitHub login or verified email.
- **Other authors** sign in with company OIDC (`EDITOR_OIDC_*`, the same provider pattern as reader sign-in). They must be registered first (`opend-server editor add-user`) and are matched by verified email, then by issuer and subject.

**Staff preview inside the editor.** Previewing a page "as an org" creates a row in `editor_previews`. Each row is tied to the editor, their session, one commit and the org's entitlements at that moment, and expires after 30 minutes. Creating one is logged in `editor_audit`. The preview renders through the same `viewRelease` and `readerPolicy` as delivery, so the docs site needs no change and never accepts editor sessions.

**Commits through the GitHub App, crediting the author.**

- **API:** the editor uses the App's installation token (`GitHubApp.installationRequest`) and the git data API: blobs, trees, commits and refs.
- **Author line:** the commit's author name and email come from the server-side session, never from the browser. The message ends with a `Co-authored-by: Name <email>` trailer.
- **Pull requests:** the PR body names the author, and the squash commit made on publish carries the trailer again.
- **Audit:** GitHub shows only the App for people without a GitHub account, so `editor_audit` records the session, user, commit SHA and PR number of every save, merge from main, resolution, publish, merge and escalation.

**One working branch per author.**

- **Branch:** each author has one active branch, `editor/<user-id>/<slug>`, registered in `editor_branches`. A partial unique index enforces "one active branch".
- **Ownership:** every write names the branch, and the server refuses any branch that is not the signed-in author's active branch, including `main`.
- **Save:** each save is a commit to that branch, with no pull request.
- **Publish:** opens one pull request for everything on the branch, or updates the open one.
- **After the merge:** once the PR is merged, the branch is retired and the next save starts a new one.

**Review rules come from GitHub.**

- **Reading the rules:** on publish, the editor reads classic branch protection and rulesets for the base branch. A 404 means no rules. A 403 means the rules are hidden from the App, and then the editor never merges by itself.
- **What it shows:** required approvals, code-owner review and required checks, plus what still blocks the merge (missing approvals, requested changes, pending or failed checks).
- **Auto-merge:** when nothing blocks, it squash-merges at the exact head it validated.
- **Changes requested:** the author keeps editing the same branch, and each save updates the pull request.

**Merge, never rebase.**

- **When:** on opening a page and after every save, the editor merges the base branch into the author's branch with `POST /repos/{o}/{r}/merges`. It never force-pushes.
- **On a conflict (409):** the editor compares the merge base with both heads, file by file, using a line-based three-way merge (`merge3`):
  - files changed on only one side, or changed in separate sections, merge automatically;
  - the rest are shown side by side, "your version" and "current version".
- **Choosing:** the author picks, per file, "keep mine", "keep current" or "edit by hand". The hand-edit textarea starts with conflict markers, and a save with markers left in is refused. The choices are committed as a merge commit with both heads as parents.
- **Structural conflicts escalate to a developer in the pull request, with a note:**
  - a file deleted on one side and changed on the other;
  - a binary file changed on both sides;
  - a section (element `id`) the author still has that was deleted on main.
- **Stale choices:** if either head moved since the choices were shown, the resolution is refused.

**DITA source editing in v1.** (Visual editing was added later; see ADR 0013.)

- **Editing:** authors edit a topic's or map's source in a plain textarea. They can also create a topic from a template (concept, task, reference or topic), optionally adding it to a map.
- **Checks:** the server checks well-formedness before every save and refuses broken XML. OpenD validation shows inline but does not block saving; it does block publishing.
- **Live preview:** builds the branch's tree, with the unsaved edit laid over it, in-process with `buildRelease` and `validate`. Files come from the GitHub API, and blobs and trees are cached by SHA. Pages render with `render-html` in the staff view, with conditions marked.

**Server-rendered, CSP-strict UI.**

- **Pages:** plain HTML forms that work without JavaScript. One small script (`/assets/editor.js`, a type-checked function served through `toString` like the embed scripts) adds the live preview and saving without a reload.
- **Editor CSP:** `script-src 'self'`, `style-src 'self'` and `frame-ancestors 'none'`.
- **Preview CSP:** previews are framed by the editor only and allow no scripts at all.
- **Requests:** state-changing requests need a per-session CSRF token and, when the browser sends one, the editor's Origin.

## Consequences

- **GitHub App permissions:** the App needs more than the worker does: Contents and Pull requests (read and write), Administration (read, for branch protection), Commit statuses and Checks (read) and Metadata (read, for collaborator permission). Without Administration read the editor still works, but nothing merges automatically.
- **Testing:** GitHub is behind a `GitHubClient` interface. Tests run the real REST client and App token flow against `FakeGitHub`, an in-process fake of the endpoints used. Its merges are file-level, which is stricter than GitHub; the editor's line-level `merge3` then commits those merges itself.
- **Scale:** the draft preview rebuilds the whole docs tree in memory on each change (debounced in the browser). That suits docs repositories of hundreds of topics. Very large repositories, over GitHub's recursive tree limit, are refused.
- **Open: a visual editor.** v1 edits DITA source. A structured visual editor (WYSIWYG over the DITA subset in ADR 0002) is an open decision. It would plug in where the textarea is and keep the same save, preview and publish path.
- **Later:** per-hunk conflict choices instead of per-file, editor roles (for example, who may preview as an org), and moving the reader admin API behind editor sign-in.
