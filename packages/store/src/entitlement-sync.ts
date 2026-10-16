import { audit } from './audit.js';
import { CHANNELS, notify, withTransaction, type Db, type Pool } from './db.js';
import {
  deleteOrg,
  setEntitlements,
  upsertOrg,
  upsertReader,
  type Entitlements,
} from './readers.js';

/**
 * Customer and licence data pushed from billing or a CRM: by snapshot (the
 * admin API and the nightly reconcile) or by per-org change events (the signed
 * webhook). Both are turned into the desired end state, diffed against the
 * database, and applied in one transaction.
 */

export interface SnapshotReader {
  email: string;
  name?: string | null;
}

export interface SnapshotOrg {
  slug: string;
  name: string;
  /** Omitted: keep the org's current entitlements. `null`: revoke them (readers see nothing). */
  entitlements?: Entitlements | null;
  readers?: (string | SnapshotReader)[];
}

export interface EntitlementSnapshot {
  orgs: SnapshotOrg[];
}

export type EntitlementEvent =
  /** Creates or updates an org. Its readers are added; with `exactReaders`, unlisted ones are removed. */
  | { type: 'org.upsert'; org: SnapshotOrg; exactReaders?: boolean }
  | { type: 'org.delete'; slug: string }
  | { type: 'reader.add'; org: string; email: string; name?: string | null }
  | { type: 'reader.remove'; email: string };

/** `merge` only creates and updates; `replace` also removes orgs and readers not in the snapshot. */
export type SyncMode = 'merge' | 'replace';

export type SyncInput =
  { snapshot: EntitlementSnapshot; mode: SyncMode } | { events: EntitlementEvent[] };

export interface SyncOptions {
  /** Who made the change, for the audit log. */
  actor: string;
  /** Where the data came from (an export URL, a CRM name), for the audit log. */
  source?: string;
  /** Compute the changes without writing anything. */
  dryRun?: boolean;
}

export interface OrgChange {
  slug: string;
  name?: { from: string | null; to: string };
  entitlements?: { from: Entitlements | null; to: Entitlements | null };
}

export interface ReaderChange {
  email: string;
  org: string;
  /** Set when the reader moves between orgs. */
  fromOrg?: string;
  name?: { from: string | null; to: string | null };
}

export interface SyncChanges {
  orgs: { created: OrgChange[]; updated: OrgChange[]; removed: string[] };
  readers: { created: ReaderChange[]; updated: ReaderChange[]; removed: ReaderChange[] };
}

export interface SyncSummary {
  orgs: { created: number; updated: number; removed: number };
  readers: { created: number; updated: number; removed: number };
}

export interface SyncResult {
  mode: SyncMode | 'events';
  dryRun: boolean;
  summary: SyncSummary;
  changes: SyncChanges;
}

/** A snapshot or event that cannot be applied, such as a reader for an unknown org. */
export class SyncError extends Error {}

interface OrgState {
  name: string;
  entitlements: Entitlements | null;
}
interface ReaderState {
  email: string;
  org: string;
  name: string | null;
}
interface State {
  orgs: Map<string, OrgState>;
  /** Keyed by lower-case email, as readers are matched. */
  readers: Map<string, ReaderState>;
}

/** Serialises syncs so two pushes cannot interleave their diffs. */
const SYNC_LOCK = 4224243;

async function loadState(db: Db): Promise<State> {
  const orgs = await db.query<{
    slug: string;
    name: string;
    products: string[] | null;
    features: string[] | null;
    version: string | null;
  }>(
    `select o.slug, o.name, e.products, e.features, e.version
     from orgs o left join entitlements e on e.org_id = o.id`,
  );
  const readers = await db.query<{ email: string; org: string; name: string | null }>(
    'select r.email, o.slug as org, r.name from readers r join orgs o on o.id = r.org_id',
  );
  return {
    orgs: new Map(
      orgs.rows.map((o) => [
        o.slug,
        {
          name: o.name,
          entitlements:
            o.version === null
              ? null
              : { products: o.products ?? [], features: o.features ?? [], version: o.version },
        },
      ]),
    ),
    readers: new Map(readers.rows.map((r) => [r.email.toLowerCase(), r])),
  };
}

function cloneState(state: State): State {
  return { orgs: new Map(state.orgs), readers: new Map(state.readers) };
}

function readerOf(r: string | SnapshotReader): SnapshotReader {
  return typeof r === 'string' ? { email: r } : r;
}

/** Writes one org and its listed readers into `next`; returns the lower-case emails listed. */
function putOrg(current: State, next: State, org: SnapshotOrg): Set<string> {
  const prev = next.orgs.get(org.slug) ?? current.orgs.get(org.slug);
  next.orgs.set(org.slug, {
    name: org.name,
    entitlements: org.entitlements === undefined ? (prev?.entitlements ?? null) : org.entitlements,
  });
  const listed = new Set<string>();
  for (const entry of org.readers ?? []) {
    const r = readerOf(entry);
    const email = r.email.trim();
    const key = email.toLowerCase();
    if (listed.has(key)) throw new SyncError(`reader ${email} is listed twice in org ${org.slug}`);
    listed.add(key);
    const was = next.readers.get(key) ?? current.readers.get(key);
    next.readers.set(key, {
      email: was?.email ?? email,
      org: org.slug,
      name: r.name ?? was?.name ?? null,
    });
  }
  return listed;
}

function fromSnapshot(current: State, snapshot: EntitlementSnapshot, mode: SyncMode): State {
  const next: State =
    mode === 'replace' ? { orgs: new Map(), readers: new Map() } : cloneState(current);
  const seenOrgs = new Set<string>();
  const seenReaders = new Map<string, string>();
  for (const org of snapshot.orgs) {
    if (seenOrgs.has(org.slug)) throw new SyncError(`org ${org.slug} appears twice`);
    seenOrgs.add(org.slug);
    for (const key of putOrg(current, next, org)) {
      const other = seenReaders.get(key);
      if (other) throw new SyncError(`reader ${key} is listed in both ${other} and ${org.slug}`);
      seenReaders.set(key, org.slug);
    }
  }
  return next;
}

function fromEvents(current: State, events: EntitlementEvent[]): State {
  const next = cloneState(current);
  const removeReaders = (match: (r: ReaderState) => boolean) => {
    for (const [key, r] of next.readers) if (match(r)) next.readers.delete(key);
  };
  events.forEach((event, i) => {
    switch (event.type) {
      case 'org.upsert': {
        const listed = putOrg(current, next, event.org);
        if (event.exactReaders) {
          removeReaders((r) => r.org === event.org.slug && !listed.has(r.email.toLowerCase()));
        }
        break;
      }
      case 'org.delete':
        next.orgs.delete(event.slug);
        removeReaders((r) => r.org === event.slug);
        break;
      case 'reader.add': {
        const org = next.orgs.get(event.org);
        if (!org) throw new SyncError(`events[${i}]: no such org ${event.org}`);
        putOrg(current, next, {
          slug: event.org,
          name: org.name,
          readers: [{ email: event.email, name: event.name ?? null }],
        });
        break;
      }
      case 'reader.remove':
        next.readers.delete(event.email.trim().toLowerCase());
        break;
    }
  });
  return next;
}

function sameEntitlements(a: Entitlements | null, b: Entitlements | null): boolean {
  if (a === null || b === null) return a === b;
  const set = (list: string[]) => [...new Set(list)].sort().join('\0');
  return (
    a.version === b.version &&
    set(a.products) === set(b.products) &&
    set(a.features) === set(b.features)
  );
}

function diffStates(current: State, next: State): SyncChanges {
  const changes: SyncChanges = {
    orgs: { created: [], updated: [], removed: [] },
    readers: { created: [], updated: [], removed: [] },
  };
  for (const [slug, org] of next.orgs) {
    const was = current.orgs.get(slug);
    const change: OrgChange = { slug };
    if (was?.name !== org.name) change.name = { from: was?.name ?? null, to: org.name };
    if (!sameEntitlements(was?.entitlements ?? null, org.entitlements)) {
      change.entitlements = { from: was?.entitlements ?? null, to: org.entitlements };
    }
    if (!was) changes.orgs.created.push(change);
    else if (change.name || change.entitlements) changes.orgs.updated.push(change);
  }
  for (const slug of current.orgs.keys()) if (!next.orgs.has(slug)) changes.orgs.removed.push(slug);

  for (const [key, r] of next.readers) {
    const was = current.readers.get(key);
    if (!was) {
      changes.readers.created.push({ email: r.email, org: r.org });
      continue;
    }
    const change: ReaderChange = { email: r.email, org: r.org };
    if (was.org !== r.org) change.fromOrg = was.org;
    if (was.name !== r.name) change.name = { from: was.name, to: r.name };
    if (change.fromOrg || change.name) changes.readers.updated.push(change);
  }
  for (const [key, r] of current.readers) {
    if (!next.readers.has(key)) changes.readers.removed.push({ email: r.email, org: r.org });
  }
  for (const list of [changes.orgs.created, changes.orgs.updated]) {
    list.sort((a, b) => a.slug.localeCompare(b.slug));
  }
  changes.orgs.removed.sort();
  for (const list of Object.values(changes.readers)) {
    list.sort((a, b) => a.email.localeCompare(b.email));
  }
  return changes;
}

function summarize(changes: SyncChanges): SyncSummary {
  return {
    orgs: {
      created: changes.orgs.created.length,
      updated: changes.orgs.updated.length,
      removed: changes.orgs.removed.length,
    },
    readers: {
      created: changes.readers.created.length,
      updated: changes.readers.updated.length,
      removed: changes.readers.removed.length,
    },
  };
}

async function applyChanges(db: Db, changes: SyncChanges, next: State): Promise<void> {
  for (const change of [...changes.orgs.created, ...changes.orgs.updated]) {
    const org = next.orgs.get(change.slug)!;
    await upsertOrg(db, { slug: change.slug, name: org.name });
    if (!change.entitlements) continue;
    if (org.entitlements) await setEntitlements(db, change.slug, org.entitlements);
    else {
      await db.query(
        'delete from entitlements where org_id = (select id from orgs where slug = $1)',
        [change.slug],
      );
    }
  }
  for (const change of [...changes.readers.created, ...changes.readers.updated]) {
    const r = next.readers.get(change.email.toLowerCase())!;
    await upsertReader(db, { orgSlug: r.org, email: r.email, name: r.name });
  }
  if (changes.readers.removed.length) {
    await db.query('delete from readers where lower(email) = any($1)', [
      changes.readers.removed.map((r) => r.email.toLowerCase()),
    ]);
  }
  for (const slug of changes.orgs.removed) await deleteOrg(db, slug);
  // Every replica clears its reader cache, so removed readers lose access at once.
  await notify(db, CHANNELS.entitlementsChanged);
}

/**
 * Applies a snapshot or events. Must run inside a transaction (the caller's,
 * so a webhook can record its idempotency key atomically with the change).
 */
export async function syncEntitlementsInTransaction(
  db: Db,
  input: SyncInput,
  options: SyncOptions,
): Promise<SyncResult> {
  await db.query('select pg_advisory_xact_lock($1)', [SYNC_LOCK]);
  const current = await loadState(db);
  const next =
    'events' in input
      ? fromEvents(current, input.events)
      : fromSnapshot(current, input.snapshot, input.mode);
  const changes = diffStates(current, next);
  const result: SyncResult = {
    mode: 'events' in input ? 'events' : input.mode,
    dryRun: options.dryRun === true,
    summary: summarize(changes),
    changes,
  };
  if (result.dryRun) return result;
  await applyChanges(db, changes, next);
  await audit(db, options.actor, 'entitlements.sync', {
    mode: result.mode,
    ...(options.source ? { source: options.source } : {}),
    summary: result.summary,
    orgsCreated: changes.orgs.created.map((o) => o.slug),
    orgsRemoved: changes.orgs.removed,
  });
  return result;
}

/** Applies a snapshot or events in its own transaction. */
export async function syncEntitlements(
  pool: Pool,
  input: SyncInput,
  options: SyncOptions,
): Promise<SyncResult> {
  return withTransaction(pool, (db) => syncEntitlementsInTransaction(db, input, options));
}
