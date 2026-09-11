# Shared D1 shard migrations

After this, an operator can initialize a Cloud-managed shard with Mobius's
SQL migrations and see them recorded in `mobius_migrations`.

Mobius Cloud owns the physical databases and their inventory in
[`infra/d1-shards.json`](https://github.com/moxt-ai/mobius-cloud/blob/main/infra/d1-shards.json).
This repository owns `packages/relay-core/migrations/d1`. Each business starts at
its own initial migration and uses its own history table. There is no old-history
adoption, baseline copying, or legacy-database conversion.

## Apply a migration

Use Node.js and pnpm from this repository, plus Bash, jq, realpath, and timeout.
From the repository root, pass the Cloud inventory, environment, shard ID, and
execution location explicitly:

```bash
pnpm db:shard /path/to/mobius-cloud/infra/d1-shards.json staging apac-01 --local
pnpm db:shard /path/to/mobius-cloud/infra/d1-shards.json staging apac-01 --remote
```

The command validates the inventory, resolves the selected shard, prints its
name and UUID, and generates a temporary Wrangler configuration with the service's
binding, migration directory, and `mobius_migrations` history table. It then
runs Cloudflare's native `wrangler d1 migrations apply` and removes the temporary
configuration. A failure returns a nonzero exit status; cancellation and a
two-minute execution deadline stop the command. Local state lives under
`packages/relay-core/.wrangler/shards`.

For remote execution, authenticate Wrangler with D1 write access to the Cloud
account. Retain the printed target and Wrangler output as the deployment audit.
To apply a release to every shard in an environment:

```bash
pnpm db:environment /path/to/mobius-cloud/infra/d1-shards.json staging --remote
```

The command validates a nonempty environment and applies its shards serially.
A migration failure stops the command before the next shard or Worker deployment.
Mobius Cloud CI runs the command with `--local` against its shared-shard inventory.
Cloud CD runs it with `--remote` for both businesses before deploying the Cloud
Worker. This command is only for the new Cloud-managed shards.

The internal `.github/actions/source` action exposes this pinned repository to
Cloud's workflow. It contains no build, migration, or deployment orchestration.
Cloud selects the source revision and serializes its releases per environment.
This repository's existing standalone Worker deployment remains independent and
uses its original configuration, database, bucket, domain, and CI workflow.

Number new SQL files
in this repository and let Wrangler apply only files absent from
`mobius_migrations`; do not rewrite an initial migration after it has been
applied to a shared shard. Stop a rollout if any target fails.

`0004_project_runtime_pairings.sql` is a forward migration. It rebuilds
`pairing_channels` while copying every existing row, assigns a deterministic
per-Project Runtime slot, backfills explicit Project-owner credentials, and
adds Runtime-pairing idempotency and audit indexes. Do not replace it with an
edited initial schema or reset a populated shard.

`0006_project_authentication.sql` is also forward-only. It preserves the
accountless owner rows, adds bounded-rotation fields to owner and Channel-host
credentials, and creates Project applications, external identity mappings,
short-lived Mobius access credentials, authentication audit events, and public
bootstrap-limit storage. Apply it before deploying a Worker that serves the
Project authentication routes described in
[Project authentication and credential operations](project-authentication.md).

Keep migration files on LF line endings and parenthesize `CASE` expressions
inside SQLite trigger bodies. Cloudflare's remote D1 migration path parses
compound statements differently from the local emulator. The repository
attributes enforce LF, and the deployment wrapper applies permanent remote D1
migrations before publishing a Worker that depends on the new schema. Dry runs
do not migrate, while temporary deployments migrate their temporary database
after Wrangler creates it.

## Rollout boundary

These commands target the new Cloud inventory, independently of the existing
Worker deployment configuration and database bindings. The existing standalone
deployment path is unchanged. Cloud CD does not migrate its database or deploy
its Worker. No old database or migration history is read, copied, renamed,
or deleted by the new command.

The new shards start empty and receive each business's initial schema. Independent
history tables do not provide SQL permissions or isolate conflicting DDL. Keep
business table ownership separate and coordinate changes that affect another
service. Business table namespacing, Clerk shard assignment, runtime routing,
and the traffic cutover remain separate work; applying schema does not switch
any workspace to a new database.

Reference: [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
