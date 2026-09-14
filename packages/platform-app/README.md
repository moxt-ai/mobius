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

## Workspace scrolling acceptance

After this, a user can scroll a long application workspace and see the header
and tenant navigation remain visible.

- Given a selected tenant whose apps and keys exceed the viewport height, When
  the user scrolls the right-hand workspace, Then the workspace scrolls to its
  last key while the header and tenant navigation stay in place.
- Given more tenants than fit in the sidebar, When the user scrolls the tenant
  list, Then every tenant remains reachable without scrolling the workspace.
- Given a narrow viewport, When the user scrolls the workspace, Then the header
  and stacked tenant navigation remain visible and the page has no horizontal
  overflow.

Verify these layout scenarios with `agent-browser` at desktop and mobile widths.

## Credential identification acceptance

After this, a user can copy the one-time App secret for server authentication
and see that existing secrets cannot be retrieved.

Verify these scenarios against the running app:

- Given an app with existing keys, When the credentials table is viewed, Then
  no Key ID, secret value, or copy button is shown, each row explains that the
  secret is only shown when created, and creation date, status, and revocation
  remain available.
- Given a newly created app or key, When Save your app secret opens, Then the
  App secret is identified as the full `mapp_…` AppCredential for
  `MOBIUS_APP_SECRET`, no Key ID is displayed, and Copy App secret copies that
  full value whether the secret is visible or hidden.
- Given a previously dismissed secret dialog, When the user returns to App keys,
  Then the page explains that Create key provides a new secret and existing
  secrets cannot be viewed again.

## Creation flow acceptance

After this, a user can click Create tenant or Create app, enter a name in a
dialog, and see the new tenant or the application's first secret.

Verify these scenarios with `agent-browser` against the running app at desktop
and mobile widths:

- Given the workspace, When Create tenant is clicked, Then a dialog opens with
  Tenant name focused. Enter a name and submit; the dialog closes and the new
  tenant is selected with a creation notice.
- Given a selected tenant, When Create app is clicked, Then a dialog opens with
  Application name focused and identifies the destination tenant. Submit a name;
  the app appears and Save your app secret replaces the name dialog.
- Given either name dialog, When Cancel, Escape, or the close button is used,
  Then no resource is created, focus returns to the trigger, and reopening starts
  with an empty name.
- Given either name dialog, When the name is empty or whitespace-only, Then
  creation is disabled. While creation is pending, the form shows Creating… and
  prevents duplicate submission. If creation fails, the name and error remain
  visible in the dialog for retry.
