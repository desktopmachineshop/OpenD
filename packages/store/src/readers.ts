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
  /** Sees the unfiltered staff view. Set only by operators (admin API, seed). */
  staff: boolean;
}

export interface Entitlements {
  products: string[];
  features: string[];
  version: string;
}

const READER_COLUMNS = `r.id, r.org_id as "orgId", r.email, r.name, r.oidc_issuer as "oidcIssuer",
  r.oidc_subject as "oidcSubject", r.staff`;

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

/**
 * Adds or moves a reader by email. Returns null when the org does not exist.
 * `staff` is changed only when given, so entitlement sync (which never passes
 * it) cannot grant or revoke the staff view.
 */
export async function upsertReader(
  db: Db,
  reader: { orgSlug: string; email: string; name?: string | null; staff?: boolean },
): Promise<Reader | null> {
  const { rows } = await db.query<Reader>(
    `with o as (select id from orgs where slug = $1)
     insert into readers as r (org_id, email, name, staff) select o.id, $2, $3, coalesce($4, false)
     from o
     on conflict ((lower(email))) do update set org_id = excluded.org_id,
       name = coalesce(excluded.name, r.name), staff = coalesce($4, r.staff)
     returning ${READER_COLUMNS}`,
    [reader.orgSlug, reader.email.trim(), reader.name ?? null, reader.staff ?? null],
  );
  await notify(db, CHANNELS.entitlementsChanged);
  return rows[0] ?? null;
}

/** Grants or revokes the staff view. Returns null when there is no such reader. */
export async function setReaderStaff(db: Db, id: number, staff: boolean): Promise<Reader | null> {
  const { rows } = await db.query<Reader>(
    `update readers r set staff = $2 where id = $1 returning ${READER_COLUMNS}`,
    [id, staff],
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

/**
 * Finds the reader for a sign-in with another provider (e.g. GitHub), by the
 * same rule as OIDC: an identity already linked to a reader wins; otherwise
 * the first verified email a registered reader has, whose reader has no
 * identity from this issuer yet, is linked on this first sign-in. Pass only
 * emails the provider has verified.
 */
export async function findReaderForIdentity(
  db: Db,
  login: { issuer: string; subject: string; verifiedEmails: readonly string[] },
): Promise<Reader | null> {
  const linked = await db.query<Reader>(
    `select ${READER_COLUMNS} from readers r
     join reader_identities i on i.reader_id = r.id where i.issuer = $1 and i.subject = $2`,
    [login.issuer, login.subject],
  );
  if (linked.rows[0]) return linked.rows[0];
  for (const email of login.verifiedEmails) {
    const { rows } = await db.query<Reader>(
      `with linked as (
         insert into reader_identities (reader_id, issuer, subject)
         select r.id, $1, $2 from readers r
         where lower(r.email) = lower($3)
           and not exists (select 1 from reader_identities i where i.reader_id = r.id and i.issuer = $1)
         on conflict do nothing returning reader_id)
       select ${READER_COLUMNS} from readers r join linked on linked.reader_id = r.id`,
      [login.issuer, login.subject, email.trim()],
    );
    if (rows[0]) return rows[0];
  }
  return null;
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

/** A registered reader by email (case-insensitive), with their org's slug. */
export async function findReaderByEmail(
  db: Db,
  email: string,
): Promise<(Reader & { orgSlug: string }) | null> {
  const { rows } = await db.query<Reader & { orgSlug: string }>(
    `select ${READER_COLUMNS}, o.slug as "orgSlug" from readers r join orgs o on o.id = r.org_id
     where lower(r.email) = lower($1)`,
    [email.trim()],
  );
  return rows[0] ?? null;
}
