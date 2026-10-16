import { LRUCache } from 'lru-cache';
import type { PublicationView, ReleaseView } from '@opend/filter';
import type { PdfRenderer } from '@opend/pdf';
import type { BlobStore, Pool, ReaderAccess, Repo, StoredRelease } from '@opend/store';
import type { Log } from '@opend/worker';
import type { ServerConfig } from './config.js';
import type { OidcProvider } from './oidc.js';

/**
 * In-memory caches. Every replica keeps its own; LISTEN/NOTIFY clears them when
 * a release goes live or entitlements change, and short TTLs bound staleness
 * if a notification is missed.
 */
export class Caches {
  /** Reader id → access (org and entitlements). `null` caches "no such reader". */
  readonly readers = new LRUCache<number, { access: ReaderAccess | null }>({
    max: 10_000,
    ttl: 60_000,
  });
  /** The repo the site serves. */
  site: { repo: Repo | null; at: number } | null = null;
  /** `repoId:line` → live release id (or null). */
  readonly live = new LRUCache<string, { id: number | null }>({ max: 100, ttl: 60_000 });
  /** Release id → stored release. Releases never change once written. */
  readonly releases = new LRUCache<number, StoredRelease>({ max: 8 });
  /** `releaseId|entitlementKey` → filtered view. Shared by every reader with the same entitlements. */
  readonly views = new LRUCache<string, ReleaseView>({ max: 200 });
  /** `releaseId|entitlementKey|topicId` → rendered page. */
  readonly pages = new LRUCache<string, string>({ max: 2000 });
  /** `releaseId|entitlementKey|publicationFile` → filtered publication view. */
  readonly publications = new LRUCache<string, { view: PublicationView | null }>({ max: 200 });

  releaseChanged(): void {
    this.site = null;
    this.live.clear();
    this.views.clear();
    this.pages.clear();
    this.publications.clear();
  }

  entitlementsChanged(): void {
    this.readers.clear();
  }
}

export interface AppContext {
  config: ServerConfig;
  pool: Pool;
  blobs: BlobStore;
  log: Log;
  caches: Caches;
  oidc: OidcProvider | null;
  /** Prints publications. Generated PDFs are cached in `blobs`. */
  pdf: PdfRenderer;
}
