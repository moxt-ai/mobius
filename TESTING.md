# Testing

For routine changes, run `pnpm lint`, `pnpm typecheck`, and the relevant integration cases. `pnpm test` runs controlled Agent plus daemon tests, SDK tests, and local Cloudflare Platform Worker integration tests. `pnpm build` verifies the CLI, SDK, protocol, relay, and Worker bundles without deploying them.

Start behavioral changes with a failing Given-When-Then scenario through the first supported product boundary. Worker tests enter through HTTP, WebSocket, Durable Object, or storage boundaries. Agent tests use the production daemon and a stateful controlled ACP Agent. Assert observable behavior. Use deterministic fake timers for time-dependent cases.

Local tests create fresh databases from committed migrations. Existing database contents and old schema versions are outside this repository's contract. Mobius Chat integration will be verified after its submodule reference and SDK dependency are updated.
