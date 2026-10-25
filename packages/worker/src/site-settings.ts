import { compareReleaseLines, releaseLine } from '@opend/filter';
import type { ReleaseLines, SiteSettings } from '@opend/model';
import {
  audit,
  getRepo,
  listLiveReleases,
  setRepoAccess,
  setRepoDeclaredSettings,
  setRepoReleaseLines,
  setRepoReleaseRefs,
  setRepoVersionPicker,
  type PoolClient,
  type Repo,
} from '@opend/store';

/** The audit actor of changes the docs repository's `site:` block makes. */
export const REPO_CONFIG_ACTOR = 'repo:opend.config.yaml';

/**
 * Switches a repo's release-line granularity and moves its live releases to
 * their new lines, in the caller's transaction (see `setRepoReleaseLines`).
 * Null when the repo does not exist.
 */
export async function changeReleaseLines(
  db: PoolClient,
  repoId: number,
  lines: ReleaseLines,
  actor: string,
): Promise<Repo | null> {
  const result = await setRepoReleaseLines(db, repoId, lines, (v) => releaseLine(v, lines));
  if (result?.changed)
    await audit(db, actor, 'repo.release-lines', {
      repo: result.repo.fullName,
      releaseLines: lines,
    });
  return result?.repo ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Where applied settings came from: the build whose config declared them. */
export interface SettingsSource {
  releaseId: number;
  ref: string;
  sha: string;
  release: string;
}

/**
 * Applies the `site:` block of a published build's `opend.config.yaml` to its
 * repo, through the same store calls and audit entries as the admin API, as
 * `repo:opend.config.yaml`. Only the build live on the repo's newest release
 * line speaks for the site: a build of an older line (a backport) or one a
 * newer push already superseded changes nothing, so settings never move back
 * to an older branch's. Fields the block leaves out stay as they are
 * (console-managed); `site` undefined clears the record of declared fields.
 *
 * Runs in the publishing transaction (`PublishInput.onLive`), so the settings
 * and the release they came with go live together. Every setter notifies the
 * replicas to drop their caches, so pages, views and the public audience
 * follow at commit. Returns the fields changed, or null when this build does
 * not speak for the site.
 */
export async function applySiteSettings(
  db: PoolClient,
  repoId: number,
  source: SettingsSource,
  site: SiteSettings | undefined,
): Promise<string[] | null> {
  const current = await getRepo(db, repoId);
  if (!current) return null;
  const newest = (await listLiveReleases(db, repoId)).sort((a, b) =>
    compareReleaseLines(b.releaseLine, a.releaseLine),
  )[0];
  if (newest?.releaseId !== source.releaseId) return null;

  const changed: string[] = [];
  const from = { ref: source.ref, sha: source.sha };
  const settings = site ?? {};
  if (settings.releaseLines && settings.releaseLines !== current.releaseLines) {
    await changeReleaseLines(db, repoId, settings.releaseLines, REPO_CONFIG_ACTOR);
    changed.push('releaseLines');
  }
  if (settings.access !== undefined || settings.publicEntitlements !== undefined) {
    const access = settings.access ?? current.access;
    const pub =
      settings.publicEntitlements === undefined
        ? current.publicEntitlements
        : settings.publicEntitlements;
    if (access !== current.access || !same(pub, current.publicEntitlements)) {
      await setRepoAccess(db, repoId, access, pub);
      await audit(db, REPO_CONFIG_ACTOR, 'repo.access', {
        repo: current.fullName,
        access,
        publicEntitlements: pub,
        from,
      });
      if (access !== current.access) changed.push('access');
      if (!same(pub, current.publicEntitlements)) changed.push('publicEntitlements');
    }
  }
  if (settings.versionPicker && !same(settings.versionPicker, current.versionPicker)) {
    await setRepoVersionPicker(db, repoId, settings.versionPicker);
    await audit(db, REPO_CONFIG_ACTOR, 'repo.versions', {
      repo: current.fullName,
      versionPicker: settings.versionPicker,
      from,
    });
    changed.push('versionPicker');
  }
  if (settings.releaseRefs && !same(settings.releaseRefs, current.releaseRefs)) {
    await setRepoReleaseRefs(db, repoId, settings.releaseRefs);
    await audit(db, REPO_CONFIG_ACTOR, 'repo.release-refs', {
      repo: current.fullName,
      releaseRefs: settings.releaseRefs,
      from,
    });
    changed.push('releaseRefs');
  }
  const declared = site
    ? {
        settings: site,
        ref: source.ref,
        sha: source.sha,
        release: source.release,
        appliedAt: new Date().toISOString(),
      }
    : null;
  // The record changes with every newest-line build (its sha); only notify when it does.
  if (declared || current.declared) await setRepoDeclaredSettings(db, repoId, declared);
  return changed;
}
