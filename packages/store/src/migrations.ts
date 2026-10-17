/**
 * Schema migrations, applied in order and recorded in `schema_migrations`.
 * Never edit a released migration; add a new one.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_initial',
    sql: `
create table repos (
  id bigserial primary key,
  -- owner/name on GitHub, or any unique name for a local source
  full_name text not null unique,
  -- clone URL (https://github.com/owner/name.git) or a local path
  source_url text not null,
  -- GitHub App installation; null for sources that need no token
  installation_id bigint,
  -- branch and tag names that publish, with * wildcards, e.g. {main, v*}
  release_refs text[] not null default '{main}',
  -- docs root inside the repository
  docs_path text not null default '.',
  created_at timestamptz not null default now()
);

create table build_jobs (
  id bigserial primary key,
  repo_id bigint not null references repos (id) on delete cascade,
  ref text not null,
  sha text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  error text,
  diagnostics jsonb not null default '[]',
  release_id bigint,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index build_jobs_claim on build_jobs (status, run_after);

create table releases (
  id bigserial primary key,
  repo_id bigint not null references repos (id) on delete cascade,
  job_id bigint not null references build_jobs (id),
  ref text not null,
  sha text not null,
  release text not null,
  release_line text not null,
  snapshot jsonb not null,
  diagnostics jsonb not null default '[]',
  built_at timestamptz not null default now()
);
alter table build_jobs add foreign key (release_id) references releases (id);

-- The release each reader line is served. Swapped only after a build passes.
create table live_releases (
  repo_id bigint not null references repos (id) on delete cascade,
  release_line text not null,
  release_id bigint not null references releases (id),
  updated_at timestamptz not null default now(),
  primary key (repo_id, release_line)
);

create table webhook_deliveries (
  id text primary key,
  event text not null,
  received_at timestamptz not null default now()
);

create table orgs (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table entitlements (
  org_id bigint primary key references orgs (id) on delete cascade,
  products text[] not null default '{}',
  features text[] not null default '{}',
  version text not null,
  updated_at timestamptz not null default now()
);

create table readers (
  id bigserial primary key,
  org_id bigint not null references orgs (id) on delete cascade,
  email text not null,
  name text,
  oidc_issuer text,
  oidc_subject text,
  created_at timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);
create unique index readers_email on readers (lower(email));

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  detail jsonb not null default '{}'
);
`,
  },
  {
    id: '002_editor',
    sql: `
-- Web editor accounts. A separate identity pool from readers: an editor
-- session never grants reader access and a reader session never opens the editor.
create table editor_users (
  id bigserial primary key,
  email text not null,
  name text not null default '',
  github_id bigint unique,
  github_login text,
  oidc_issuer text,
  oidc_subject text,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);
create unique index editor_users_email on editor_users (lower(email));
create unique index editor_users_github_login on editor_users (lower(github_login));

-- The editor cookie holds only a signed session id; the row makes sign-out
-- revoke it and gives every audited action a session.
create table editor_sessions (
  id text primary key,
  user_id bigint not null references editor_users (id) on delete cascade,
  provider text not null check (provider in ('github', 'oidc')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index editor_sessions_user on editor_sessions (user_id);

-- Which working branch belongs to which author. Writes to a branch are only
-- accepted from its owner.
create table editor_branches (
  id bigserial primary key,
  repo_id bigint not null references repos (id) on delete cascade,
  user_id bigint not null references editor_users (id) on delete cascade,
  branch text not null,
  base_branch text not null,
  head_sha text,
  pr_number int,
  status text not null default 'active' check (status in ('active', 'merged', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, branch)
);
-- One working branch per author and repository at a time.
create unique index editor_branches_active on editor_branches (repo_id, user_id)
  where status = 'active';

-- Every save, publish and merge, with the person behind it. GitHub only shows
-- the app for authors without a GitHub account.
create table editor_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  session_id text,
  user_id bigint references editor_users (id) on delete set null,
  repo_id bigint references repos (id) on delete set null,
  branch text,
  action text not null,
  commit_sha text,
  pr_number int,
  detail jsonb not null default '{}'
);
create index editor_audit_user on editor_audit (user_id, id);

-- Staff "preview as an org": short-lived, tied to one session and one commit.
create table editor_previews (
  id text primary key,
  user_id bigint not null references editor_users (id) on delete cascade,
  session_id text not null,
  repo_id bigint not null references repos (id) on delete cascade,
  org_slug text not null,
  context jsonb not null,
  commit_sha text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
`,
  },
  {
    // Self-contained so it applies whether or not 002_editor runs before it.
    id: '003_polling',
    sql: `
-- Last head sha the poller saw for each release ref, for webhook-less installs.
create table if not exists polled_refs (
  repo_id bigint not null references repos (id) on delete cascade,
  ref text not null,
  sha text not null,
  -- the job the poller queued for this sha; null when one already existed
  job_id bigint references build_jobs (id) on delete set null,
  seen_at timestamptz not null default now(),
  primary key (repo_id, ref)
);
create index if not exists build_jobs_repo_ref_sha on build_jobs (repo_id, ref, sha);
`,
  },
  {
    id: '004_search',
    sql: `
-- Full-text search, written by the worker when it publishes a release (and by
-- opend-server reindex). Only tsvectors are stored, never readable text, and
-- results are always re-checked against the reader's filtered view; see ADR 0008.
create table search_indexes (
  release_id bigint primary key references releases (id) on delete cascade,
  -- SEARCH_INDEX_FORMAT of the segmentation that wrote the rows
  format int not null,
  indexed_at timestamptz not null default now()
);

-- Each distinct condition text sits behind. cond_key is a hash of gates, so it
-- means the same thing in every release and across reindexing.
create table search_conditions (
  release_id bigint not null references search_indexes (release_id) on delete cascade,
  cond_key text not null,
  gates jsonb not null,
  primary key (release_id, cond_key)
);

-- One row per run of topic text with a single condition and weight.
create table search_segments (
  release_id bigint not null references search_indexes (release_id) on delete cascade,
  topic_id text not null,
  seq int not null,
  cond_key text not null,
  tsv tsvector not null,
  primary key (release_id, topic_id, seq),
  foreign key (release_id, cond_key) references search_conditions (release_id, cond_key)
    on delete cascade
);

-- Every segment of a topic, whatever its condition. Only narrows candidates:
-- a topic is ranked on the segments the reader can see.
create table search_topics (
  release_id bigint not null references search_indexes (release_id) on delete cascade,
  topic_id text not null,
  tsv tsvector not null,
  primary key (release_id, topic_id)
);
create index search_topics_tsv on search_topics using gin (tsv);

create aggregate opend_tsvector_agg (tsvector) (
  sfunc = tsvector_concat,
  stype = tsvector,
  initcond = ''
);
`,
  },
  {
    // Self-contained (and numbered past 004) so it applies in any order with other migrations.
    id: '005_analytics',
    sql: `
-- Docs analytics. Deliberately no reader id, email or IP address: only the org,
-- what was looked at and where. Purged after OPEND_ANALYTICS_RETENTION_DAYS.
create table if not exists analytics_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('view', 'search')),
  surface text not null check (surface in ('site', 'embed', 'api')),
  org_slug text not null,
  release_line text not null,
  -- views: the topic shown
  topic_id text,
  -- searches: the normalised query and how many hits it returned
  query text check (char_length(query) <= 200),
  result_count int
);
create index if not exists analytics_events_at on analytics_events (at);
create index if not exists analytics_events_kind_at on analytics_events (kind, at);

-- "Was this page helpful?" answers. The comment is untrusted reader text.
create table if not exists analytics_feedback (
  id bigserial primary key,
  at timestamptz not null default now(),
  surface text not null check (surface in ('site', 'embed')),
  org_slug text not null,
  release_line text not null,
  topic_id text not null,
  helpful boolean not null,
  comment text check (char_length(comment) <= 1000)
);
create index if not exists analytics_feedback_at on analytics_feedback (at);
create index if not exists analytics_feedback_topic_at on analytics_feedback (topic_id, at);
`,
  },
  {
    id: '006_access',
    sql: `
-- Who may read a site. 'private': only signed-in, registered readers. 'public':
-- anonymous visitors too, filtered for public_entitlements ({products, features,
-- version}); null there means anonymous visitors see only unconditioned content.
-- Operator-controlled through the admin API, never read from the docs repository.
alter table repos add column if not exists access text not null default 'private'
  check (access in ('private', 'public'));
alter table repos add column if not exists public_entitlements jsonb;

-- Staff readers (the docs owner and their team) see the unfiltered staff view.
-- Only the admin API and seed files set it; entitlement sync never touches it.
alter table readers add column if not exists staff boolean not null default false;

-- Sign-in identities other than the OIDC subject on readers, e.g. GitHub user
-- ids. Linked on the first sign-in with a verified email, then matched by id.
create table if not exists reader_identities (
  reader_id bigint not null references readers (id) on delete cascade,
  issuer text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  primary key (issuer, subject),
  unique (reader_id, issuer)
);

-- Anonymous visitors of public sites have no org.
alter table analytics_events alter column org_slug drop not null;
`,
  },
  {
    id: '007_settings',
    sql: `
-- Settings site owners change in the admin console (sign-in, GitHub connection,
-- editor links), as JSON per key. Environment variables, where set, win.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- Secrets for those settings, sealed with AES-256-GCM (OPEND_SECRET_KEY, or a
-- key derived from SESSION_SECRET). Plaintext never reaches the database, and
-- no route ever returns or renders a secret. key_id tells which key sealed it.
create table if not exists secrets (
  name text primary key,
  sealed text not null,
  key_id text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- One-time links that make the first staff reader (opend-server admin-link, or
-- POST /admin/api/setup-links). Only a hash of each token is kept.
create table if not exists admin_setup_tokens (
  token_hash text primary key,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
`,
  },
];
