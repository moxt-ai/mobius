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

The selected tenant is Clerk's active organization: `selectedTenantId = organization.id`.
The sidebar uses Clerk's organization switcher, including organization creation
and management. Personal sessions must select an organization first. Switching
organizations resets the workspace so apps and revealed secrets from the previous
organization are not displayed in the new one.

`platform-app` owns its Vite and Clerk composition together with its UI,
view-models, services, and Platform SDK integration.

## Workspace scrolling acceptance

After this, a user can scroll a long application workspace and see the header
and tenant navigation remain visible.

- Given a selected tenant whose apps and keys exceed the viewport height, When
  the user scrolls the right-hand workspace, Then the workspace scrolls to its
  last key while the header and tenant navigation stay in place.
- Given membership in multiple organizations, When the user opens Clerk's
  organization switcher, Then another organization can be selected.
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

After this, a user can select a Clerk organization, click Create app, enter a
name in a dialog, and see the application's first secret.

Verify these scenarios with `agent-browser` against the running app at desktop
and mobile widths:

- Given a signed-in user, When they create an organization through Clerk's
  switcher, Then the new organization becomes the selected tenant and its ID
  appears in the workspace.
- Given a selected tenant, When Create app is clicked, Then a dialog opens with
  Application name focused and identifies the destination tenant. Submit a name;
  the app appears and Save your app secret replaces the name dialog.
- Given the application name dialog, When Cancel, Escape, or the close button is used,
  Then no resource is created, focus returns to the trigger, and reopening starts
  with an empty name.
- Given the application name dialog, When the name is empty or whitespace-only, Then
  creation is disabled. While creation is pending, the form shows Creating… and
  prevents duplicate submission. If creation fails, the name and error remain
  visible in the dialog for retry.
