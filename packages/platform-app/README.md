# Mobius Platform App

After this, a user can sign in with Clerk, manage their Mobius tenants and apps,
copy each App ID, and create or revoke multiple server credentials.

## Hosted app

- Staging: https://mobius.paradev.biz/
- Production: https://mobius.paraflow.biz/

The Platform Worker serves this app and its API on the same origin. The
`mobius-platform.paradev.biz` and `mobius-platform.paraflow.biz` domains remain
available as aliases for existing API clients.

## Run

Set `VITE_CLERK_PUBLISHABLE_KEY` in the build environment or in this package's
`.env.<mode>.local` file. Builds fail if the key is missing or blank. Use the
Clerk instance configured for the target Platform API.

The repository's `pnpm wrangler deploy --config
packages/relay-cloudflare-platform/wrangler.jsonc --env staging` command forwards
the environment to Vite. Use `--env production` for production. For a direct
app build, use `pnpm --filter @moxt-ai/mobius-platform-app build --mode staging`
or `--mode production`. Rebuild and redeploy to update an already-published bundle;
Worker runtime variables cannot change Vite's compiled browser configuration.

From the repository root:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_... \
VITE_MOBIUS_PLATFORM_ENDPOINT=https://mobius.paradev.biz \
pnpm --filter @moxt-ai/mobius-platform-app dev
```

The Clerk session token is sent directly to the configured Platform API, which
owns authentication and tenant authorization. Credential secrets are returned
and displayed only when created; subsequent reads expose metadata only.

`platform-app` owns its Vite and Clerk composition together with its UI,
view-models, services, and Platform SDK integration.
