import type { ReaderContext } from '@opend/model';
import { CHANNELS, notify, type Db } from './db.js';

export interface Org {
  id: number;
  slug: string;
  name: string;
  products: string[];
  features: string[];
  version: string | null;
}

export interface Reader {
  id: number;
  orgId: number;
  email: string;
  name: string | null;
  oidcIssuer: string | null;
  oidcSubject: string | null;
}

export interface Entitlements {
  products: string[];
  features: string[];
  version: string;
}

const READER_COLUMNS = `r.id, r.org_id as "orgId", r.email, r.name, r.oidc_issuer as "oidcIssuer",
  r.oidc_subject as "oidcSubject"`;

export async function upsertOrg(db: Db, org: { slug: string; name: string }): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into orgs (slug, name) values ($1, $2)
     on conflict (slug) do update set name = excluded.name returning id`,
    [org.slug, org.name],
  );
  await notify(db, CHANNELS.entitlementsChanged);
  return rows[0]!.id;
}

/** Returns false when the org does not exist. */
export async function setEntitlements(db: Db, orgSlug: string, e: Entitlements): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into entitlements (org_id, products, features, version)
     select id, $2, $3, $4 from orgs where slug = $1
     on conflict (org_id) do update set products = excluded.products, features = excluded.features,
       version = excluded.version, updated_at = now()`,
    [orgSlug, e.products, e.features, e.version],
  );
  await notify(db, CHANNELS.entitlementsChanged);
  return rowCount === 1;
}

export async function deleteOrg(db: Db, slug: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from orgs where slug = $1', [slug]);
  await notify(db, CHANNELS.entitlementsChanged);
  return rowCount === 1;
}

export async function listOrgs(db: Db): Promise<Org[]> {
  const { rows } = await db.query<Org>(
    `select o.id, o.slug, o.name, coalesce(e.products, '{}') as products,
       coalesce(e.features, '{}') as features, e.version
     from orgs o left join entitlements e on e.org_id = o.id order by o.slug`,
  );
  return rows;
}

/** Adds or moves a reader by email. Returns null when the org does not exist. */
export async function upsertReader(
  db: Db,
  reader: { orgSlug: string; email: string; name?: string | null },
): Promise<Reader | null> {
  const { rows } = await db.query<Reader>(
    `with o as (select id from orgs where slug = $1)
     insert into readers as r (org_id, email, name) select o.id, $2, $3 from o
     on conflict ((lower(email))) do update set org_id = excluded.org_id,
       name = coalesce(excluded.name, r.name)
     returning ${READER_COLUMNS}`,
    [reader.orgSlug, reader.email.trim(), reader.name ?? null],
  );
  await notify(db, CHANNELS.entitlementsChanged);
  return rows[0] ?? null;
}

export async function deleteReader(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query('delete from readers where id = $1', [id]);
  await notify(db, CHANNELS.entitlementsChanged);
  return rowCount === 1;
}

export async function listReaders(db: Db): Promise<(Reader & { orgSlug: string })[]> {
  const { rows } = await db.query<Reader & { orgSlug: string }>(
    `select ${READER_COLUMNS}, o.slug as "orgSlug" from readers r join orgs o on o.id = r.org_id
     order by o.slug, r.email`,
  );
  return rows;
}

/**
 * Finds the reader for an OIDC login. A reader already linked to this issuer
 * and subject wins. Otherwise a verified email the admin registered is linked
 * to the subject on first login. Unverified emails never match.
 */
export async function findReaderForLogin(
  db: Db,
  login: { issuer: string; subject: string; email?: string; emailVerified?: boolean },
): Promise<Reader | null> {
  const linked = await db.query<Reader>(
    `select ${READER_COLUMNS} from readers r where oidc_issuer = $1 and oidc_subject = $2`,
    [login.issuer, login.subject],
  );
  if (linked.rows[0]) return linked.rows[0];
  if (!login.email || login.emailVerified !== true) return null;
  const { rows } = await db.query<Reader>(
    `update readers r set oidc_issuer = $1, oidc_subject = $2
     where lower(email) = lower($3) and oidc_subject is null
     returning ${READER_COLUMNS}`,
    [login.issuer, login.subject, login.email],
  );
  return rows[0] ?? null;
}

export interface ReaderAccess {
  reader: Reader;
  orgSlug: string;
  /** `null` when the org has no entitlements yet: the reader sees nothing. */
  context: ReaderContext | null;
}

export async function getReaderAccess(db: Db, readerId: number): Promise<ReaderAccess | null> {
  const { rows } = await db.query<
    Reader & {
      orgSlug: string;
      products: string[] | null;
      features: string[] | null;
      version: string | null;
    }
  >(
    `select ${READER_COLUMNS}, o.slug as "orgSlug", e.products, e.features, e.version
     from readers r join orgs o on o.id = r.org_id left join entitlements e on e.org_id = o.id
     where r.id = $1`,
    [readerId],
  );
  const row = rows[0];
  if (!row) return null;
  const { orgSlug, products, features, version, ...reader } = row;
  return {
    reader,
    orgSlug,
    context: version
      ? { org: orgSlug, products: products ?? [], features: features ?? [], version }
      : null,
  };
}
