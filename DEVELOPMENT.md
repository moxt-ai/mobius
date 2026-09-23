# Development

Mobius serves Mobius Chat through the Platform Worker and SDK. The Standalone Worker exposes the same Project, Runtime, and Session API under a single deployment-owned Project. The local CLI connects to either Worker, discovers ACP agents, and executes session commands. Protocol messages cross the client, Worker, and daemon boundaries; validate them at each receiving boundary.

## Data and migrations

The project starts from new databases and has no old-data import path. Authoritative Drizzle schemas live in each package's `src/schema/<target>` directory. Generate migrations with the pinned Drizzle CLI through the `db:generate:*` scripts. Do not edit generated migration SQL. `pnpm db:codegen` prepares ignored SQL modules for targets that cannot import `.sql` directly.

Sessions are handled in the corresponding Runtime Relay. Session content is not retained in cloud storage. Do not add a retained-content mode or a migration path for previous Mobius deployments.

## Boundaries

Server behavior flows through HTTP or Durable Object routes, services, storage, and the database. The local daemon is the execution boundary for files, processes, and Agent operations. Validate and authorize resolved targets there. Use typed errors across subsystem boundaries, deadlines for finite external operations, and cancellation for streams.

[AGENTS.md](./AGENTS.md) has the engineering rules.
