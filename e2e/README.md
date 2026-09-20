# End-to-end tests

Run the executable product journeys from the repository root after building:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k pnpm build
pnpm test:e2e
```

The normal journey uses the production Relay and public SDK with the shared
protocol-level `FakeAgentDaemon`; real Agent and production daemon compatibility
belongs to `tests/agent-daemon`. The `*.e2e.test.ts` scenario itself is the
authoritative description of what the suite proves. See
[TESTING.md](../TESTING.md) for the boundary and exception rules.
