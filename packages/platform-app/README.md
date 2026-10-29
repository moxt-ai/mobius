---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Mobius Platform App

After this, a user can sign in with Clerk, select or create an organization,
and see that organization's apps, App IDs, and server credentials.
See the [Mobius glossary](../../docs/GLOSSARY.md) for the relationship between
Tenants, Apps, Projects, credentials, and Runtimes.

## Hosted app

- Staging: https://mobius.moxt.ws/
- Production: https://mobius.moxt.ai/

The Platform Worker serves this app and its API on the same origin.

## Run

Set `VITE_CLERK_PUBLISHABLE_KEY` in the build environment or in this package's
`.env.<mode>.local` file. Builds fail if the key is missing or blank. Use the
Clerk instance configured for the target Platform API.

The Platform deployment workflow builds the app in the target mode before it runs
Wrangler. For a direct build, use `pnpm --filter @moxt-ai/mobius-platform-app
build --mode staging` or `--mode production`, then deploy the Platform Worker.
Rebuild and redeploy to update an already-published bundle; Worker runtime
variables cannot change Vite's compiled browser configuration.

From the repository root:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_... \
VITE_MOBIUS_PLATFORM_ENDPOINT=https://mobius.moxt.ws \
pnpm --filter @moxt-ai/mobius-platform-app dev
```

The Clerk session token is sent directly to the configured Platform API, which
owns authentication and tenant authorization. Credential secrets are returned
and displayed only when created; subsequent reads expose metadata only.

## Access and credentials

Users must select a Clerk organization before managing apps. Switching organizations
must clear the previous organization's workspace and any revealed secrets. An App
secret is shown only when created; existing secrets cannot be retrieved. The secret
used for server authentication is the full `mapp_…` AppCredential, not a public key ID.

Creating an app should clearly identify the destination organization, prevent duplicate
submission and preserve the entered name when a request fails. Cancelling must not
create an app.

## Manual checks

Check hosted Clerk sign-in and organization switching in a real browser. At desktop
and mobile widths, verify that long workspaces remain usable, navigation stays
visible and no horizontal overflow hides controls. Record results in the relevant
pull request; executable tests own the detailed behavioral scenarios.
