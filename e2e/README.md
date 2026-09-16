# End-to-end tests

Run the executable product journeys from the repository root after building:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k pnpm build
pnpm test:e2e
```

The `*.e2e.test.ts` scenarios themselves are the authoritative description of
what the suite proves. See [TESTING.md](../TESTING.md) for the entrypoint,
composition, fixture, and signal-to-noise requirements.
