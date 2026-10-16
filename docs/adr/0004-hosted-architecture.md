# 0004 Hosted architecture: push to publish

- Status: accepted
- Date: 2026-10-16

## Context

Stage 1 built the shared build, filter and renderer. The hosted platform has to turn a push into live docs, and serve each signed-in reader only what their org's entitlements and release allow. The deployment plan asks for:

- configuration only through environment variables;
- stateless services;
- the smallest install being the app plus Postgres;
- one image used by both the self-hosted kit and the SaaS.

## Decision

**One image, three roles.** `opend-server serve`, `opend-server worker` and `opend-server migrate` all run from `deploy/Dockerfile`. All state lives in Postgres and the blob store, so any role can be replaced or scaled out.

**Push to publish:**

1. `POST /webhooks/github` checks the HMAC signature in constant time and records the delivery id, so a redelivered webhook does nothing. For a push to a ref listed in the repo's `release_refs`, it queues a build job. Recording the delivery and queueing the job happen in one transaction, and the 202 response is sent only after that transaction commits.
2. The worker claims jobs with `FOR UPDATE SKIP LOCKED` and wakes on `NOTIFY` or a poll. For each job it:
   - fetches the exact pushed commit, sending the GitHub App installation token as a header so it never appears in the URL;
   - runs the stage 1 `buildRelease` and `validate`;
   - stores the images and theme in the blob store, keyed by commit;
   - publishes in one transaction.
3. A build that fails validation never reaches readers. The job records its diagnostics, a failed commit status shows on the commit, and the previous release stays live. Infrastructure failures, such as a fetch error, retry with backoff.
4. `live_releases` maps `(repo, release line)` to a release. The line is the major version from `opend.config.yaml`, so V1 and V2 docs are live side by side. A release replaces the live one only if it comes from a newer job, so a slow build of an old push can't overwrite a newer one.

**Readers:**

- **Sign-in:** OIDC authorization code with PKCE. A reader is matched by issuer and subject, or by a verified email the admin registered; an unverified email never matches. Unknown users are refused.
- **Session:** a signed, httpOnly cookie that holds only the reader id. Entitlements are re-read through a 60-second cache, which is cleared at once by `NOTIFY` when an admin changes them.
- **Development login:** `OPEND_DEV_LOGIN` turns on a stub login. The server refuses to start with it when `NODE_ENV=production`.

**Delivery:**

- A reader's context selects the live release for their line. The same `viewRelease` and `readerPolicy` as the previewer then filter navigation, pages and images.
- Views and rendered pages are cached per entitlement set, not per user. The user bar is inserted after the cache, so the cached HTML is the same for everyone with those entitlements.
- An image is served only if a topic visible to _that reader_ references it. Guessing an image path therefore reveals nothing.
- **Response headers:**
  - Pages are sent with `Cache-Control: private, no-store` and a strict CSP. No scripts run.
  - Author-supplied files, including SVG, are served sandboxed.

**Admin:** an admin API behind a bearer token, until staff sign-in arrives with the web editor. Every change is written to `audit_log`. `opend-server seed` loads orgs, readers, entitlements and repos from YAML.

## Consequences

- **Replicas:** several app replicas share nothing but Postgres and the blob store. Each keeps its own memory cache, cleared by `NOTIFY` and bounded by TTLs.
- **Blob storage:** the blob store is either a local folder (`BLOB_DIR`) or any S3-compatible bucket (`S3_BUCKET` and friends), so it is no longer limited to one host. The folder suits a single-host Compose install; a bucket lets the app and the worker run as separate services, as on Railway, and app replicas run on several hosts.
- **Tenancy:** there is one docs site per deployment (`OPEND_SITE_REPO` when several repos are registered). Multi-tenancy with row-level security is a later stage, and the schema leaves room for a tenant id.
- **Tests:** the push-to-publish test reuses the stage 1 leak markers over HTTP, so the hosted path must keep the same no-leak guarantees.
