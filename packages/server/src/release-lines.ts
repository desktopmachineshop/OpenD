import { compareReleaseLines } from '@opend/filter';
import type { ReleaseLines } from '@opend/model';
import { getReleaseLineSettings, listLiveReleases, type Db, type Repo } from '@opend/store';
import { defaultPublicLine } from './access.js';

/** A release line as the admin API and console show it. */
export interface ReleaseLineInfo {
  line: string;
  /** Whether a release is live on it; labels and public flags may name a line before its first build. */
  live: boolean;
  release: string | null;
  sha: string | null;
  labels: string[];
  /** Marked public through the admin API. */
  markedPublic: boolean;
  /** Served to anonymous visitors under `/v/<line>/` (public sites, live lines only). */
  public: boolean;
  /** The line `/` serves anonymous visitors of a public site. */
  default: boolean;
}

export interface ReleaseLinesInfo {
  releaseLines: ReleaseLines;
  /** The line `/` serves anonymous visitors, on public sites; null otherwise. */
  defaultLine: string | null;
  /** Label → line. */
  labels: Record<string, string>;
  /** Newest first. */
  lines: ReleaseLineInfo[];
}

/** Every line of a repo that is live or has settings, with its labels and public state. */
export async function describeReleaseLines(db: Db, repo: Repo): Promise<ReleaseLinesInfo> {
  const live = await listLiveReleases(db, repo.id);
  const settings = await getReleaseLineSettings(db, repo.id);
  const newest = [...live].sort((a, b) => compareReleaseLines(b.releaseLine, a.releaseLine))[0];
  const labelled = live.find((l) => l.releaseLine === settings.labels.latest);
  const latest = labelled ? { line: labelled.releaseLine, release: labelled.release } : null;
  const served =
    repo.access === 'public'
      ? (defaultPublicLine(repo, latest) ?? newest?.releaseLine ?? null)
      : null;
  const names = new Set([
    ...live.map((l) => l.releaseLine),
    ...Object.values(settings.labels),
    ...settings.publicLines,
  ]);
  const lines = [...names]
    .sort((a, b) => compareReleaseLines(b, a))
    .map((line): ReleaseLineInfo => {
      const l = live.find((x) => x.releaseLine === line);
      const markedPublic = settings.publicLines.includes(line);
      return {
        line,
        live: Boolean(l),
        release: l?.release ?? null,
        sha: l?.sha ?? null,
        labels: Object.entries(settings.labels)
          .filter(([, on]) => on === line)
          .map(([label]) => label),
        markedPublic,
        public: Boolean(l) && served !== null && (line === served || markedPublic),
        default: line === served,
      };
    });
  return { releaseLines: repo.releaseLines, defaultLine: served, labels: settings.labels, lines };
}
