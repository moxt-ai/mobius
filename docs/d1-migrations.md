# Shared D1 shard migrations

After this, an operator can initialize a Cloud-managed shard with Mobius's
SQL migrations and see them recorded in `mobius_migrations`.

Mobius Cloud owns the physical databases and their inventory in
[`infra/d1-shards.json`](https://github.com/moxt-ai/mobius-cloud/blob/main/infra/d1-shards.json).
This repository owns `packages/relay-cloudflare/migrations/d1`. Each business starts at
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
`packages/relay-cloudflare/.wrangler/shards`.

For remote execution, authenticate Wrangler with D1 write access to the Cloud
account. Retain the printed target and Wrangler output as the deployment audit.
To apply a release to every shard in an environment:

```bash
set -euo pipefail
inventory=/path/to/mobius-cloud/infra/d1-shards.json
for shard in $(jq -r '.staging[].id' "$inventory"); do
  pnpm db:shard "$inventory" staging "$shard" --remote
done
```

Each business runs this command from its own release independently. Serialize
releases of the same business targeting the same database. Number new SQL files
in this repository and let Wrangler apply only files absent from
`mobius_migrations`; do not rewrite an initial migration after it has been
applied to a shared shard. Stop a rollout if any target fails.

## Rollout boundary

These commands target the new Cloud inventory, independently of the existing
Worker deployment configuration and database bindings. The existing deployment
path is unchanged. No old database or migration history is read, copied, renamed,
or deleted by the new command.

The new shards start empty and receive each business's initial schema. Independent
history tables do not provide SQL permissions or isolate conflicting DDL. Keep
business table ownership separate and coordinate changes that affect another
service. Business table namespacing, Clerk shard assignment, runtime routing,
and the traffic cutover remain separate work; applying schema does not switch
any workspace to a new database.

Reference: [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
