# Mobius Platform App

After this, a user can sign in with Clerk, manage their Mobius tenants and apps,
copy each App ID, and create or revoke multiple server credentials.

## Run

From the repository root:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_... \
VITE_MOBIUS_PLATFORM_ENDPOINT=https://mobius-platform.paradev.biz \
pnpm --filter @moxt-ai/mobius-platform-app dev
```

The Clerk session token is sent directly to the configured Platform API, which
owns authentication and tenant authorization. Credential secrets are returned
and displayed only when created; subsequent reads expose metadata only.

`platform-app` owns its Vite and Clerk composition together with its UI,
view-models, services, and Platform SDK integration.
