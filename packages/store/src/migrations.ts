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
];
