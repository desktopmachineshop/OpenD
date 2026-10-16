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
];
