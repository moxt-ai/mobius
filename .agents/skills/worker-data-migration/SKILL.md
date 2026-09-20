---
name: worker-data-migration
description: Run an explicit data migration against a deployed Mobius Platform environment (staging or production) when a merged schema change also needs its existing Project and Session Durable Object storage upgraded. Use for the cloud-retention migration or any one-off data backfill that must execute on the edge after the Worker deploys.
---

# Worker Data Migration

Run the explicit data pass that a schema migration does not perform. Control-plane
D1 migrations apply automatically in CD before the Worker deploys; this skill
covers changes that must touch existing Durable Object storage.

The worked example is the cloud-retention migration
(`POST /v1/platform/migrations/cloud-retention`): it enumerates every Platform
Project, migrates its Project and Session Durable Objects, and records per-Project
completion in `platform_cloud_retention_migrations`.

## When this applies

- A merged change adds a migration that must touch existing Durable Object
  storage, not only control-plane D1.
- The migration endpoint is operator-gated and the target environment has no
  operator subject configured, so the HTTP route is unreachable
  (`MOBIUS_PLATFORM_OPERATOR_SUBJECTS=[]` in both hosted environments).
- The user explicitly asks to run the migration on staging or production.

Do not use this skill to apply schema migrations, to deploy application code, or
against an environment the user did not name.

## Core approach

Do not weaken the operator gate or change hosted configuration to run the
migration. Deploy a short-lived, token-gated helper Worker into the same account.
It binds the deployed Durable Object class by `script_name` and the control-plane
D1, so it reaches the real Durable Objects through Cloudflare's internal network
instead of the public operator route. Delete it when the run finishes.

`scripts/migrator-worker.ts` is that helper. `scripts/migrate.sh` deploys it,
drives the migration in batches, verifies completion, and deletes it on exit.

## Procedure

1. Confirm the working tree is clean. If a rebase or merge is in progress, stop
   and report rather than resolving it.
2. Read the target environment's names from
   `packages/relay-cloudflare-platform/wrangler.jsonc`: the Worker `name`, and the
   `PLATFORM_DIRECTORY_DATABASE` `database_name` and `database_id`. Never guess a
   database for an environment.
3. Confirm the deployed Worker includes the migration endpoint. Health is
   `GET /mobius/api/dashboard/health`. The migration route returns `401` without a
   developer credential, which is expected.
4. Run the migration, staging before production:

   ```sh
   scripts/migrate.sh staging
   scripts/migrate.sh production
   ```
5. Verify independently from D1 before reporting:

   ```sql
   SELECT (SELECT COUNT(*) FROM platform_projects) AS total,
          (SELECT COUNT(*) FROM platform_cloud_retention_migrations) AS migrated;
   ```

   `total` must equal `migrated`; otherwise `total - migrated` remain.

## Constraints

- Treat the helper as privileged and temporary. Always delete it, including on
  failure; the script uses a trap for this.
- Keep the helper token in a mode `0600` file, pass it to the Worker as a secret,
  and never print it.
- Never point a helper at an environment the user did not name. State the target
  before starting.
- The run has real, idempotent side effects. Re-running is a no-op because
  completed Projects are skipped, but do not run it against an unknown account.
- A corporate HTTP proxy intercepts Wrangler's remote-binding channel and makes
  every proxied request fail with `internal error`. Prefer deploying the helper to
  the edge over `wrangler dev --remote`; when a dev session is unavoidable, clear
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and their lowercase variants.

## Environment facts

- Cloudflare account ID `95af7a3d67be8c49b1619544e3ce53c0`.
- Staging Worker `mobius-platform-staging`; production `mobius-platform-production`.
- D1 bindings and IDs live in `packages/relay-cloudflare-platform/wrangler.jsonc`.
- Operator subjects (`MOBIUS_PLATFORM_OPERATOR_SUBJECTS`) are empty in both hosted
  environments, so the operator HTTP route cannot be used directly.

## Scripts

`scripts/migrate.sh <staging|production>` — deploys the helper, drains the
migration in batches of 10, verifies `total == migrated`, and deletes the helper.
Set `MOBIUS_REPOSITORY` to override the repository root and
`CLOUDFLARE_ACCOUNT_ID` to override the account.
