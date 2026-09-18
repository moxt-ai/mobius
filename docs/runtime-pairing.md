# Project Runtime pairing

Mobius supports two pairing flows. `POST /pairings` bootstraps a new Project and
its first Runtime. An authenticated Project caller with `runtime:pair` can then add independent
Runtimes to that same Project without creating another Project or owner
credential.

```text
Project
|- Runtime A -> Channel A -> Runtime Credential A
`- Runtime B -> Channel B -> Runtime Credential B
```

Each Runtime has its own generated Runtime ID, Channel ID, one-time pairing
code, Runtime Credential, connection lease, machine metadata, and Agent catalog.
Project credentials are a separate authority. Accountless owner and scoped
application credentials may pair Runtimes when their server-owned permissions
include `runtime:pair`; browser, linked-device, and Runtime daemon credentials
cannot do so. Reading and revoking use `runtime:read`
and `runtime:revoke` independently.

## Web workflow

The first pairing on the Web home page still creates one Project and its first
Runtime. After that daemon is connected, the original browser can open **Local
machines** in the conversation sidebar and:

1. select **Pair another machine**;
2. copy the displayed one-time command to the other computer;
3. keep that command running so the new Runtime daemon stays connected;
4. select **Check connection** to see the second machine's independent online
   state, workspace, and Agent catalog; and
5. revoke that Runtime later without disconnecting the other machines.

The command contains only the expiring, single-use pairing code; it never
contains the Project owner credential. A code can be claimed by one daemon and
expires after ten minutes. The page distinguishes a claimed-but-offline daemon
from a connected Runtime instead of treating claim as proof of liveness.

**Access from other devices** remains a separate browser-linking flow. A browser
opened through that one-time access link can view the Project Runtime directory,
but it cannot create or revoke Runtime pairings. Adding a local execution
machine must always begin in the original owner browser's **Local machines**
page.

## Public API

All paths are beneath the configured Mobius API prefix, normally
`/mobius/api`.

Create one pending Runtime pairing with a caller-owned idempotency key:

```http
POST /v1/projects/{projectId}/runtime-pairings
Authorization: Bearer <project-owner-credential>
Content-Type: application/json

{"idempotencyKey":"install-build-mac-2026-09-09"}
```

The key is an identifier of at most 128 characters. Retrying with the same
owner credential, Project, and key returns the same pairing, including the same
one-time inputs, rather than allocating another Runtime:

```json
{
  "pairingId": "...",
  "pairingCode": "XXXX-XXXX-XXXX-XXXX-XXXX",
  "pollToken": "...",
  "channelId": "chn_...",
  "runtimeId": "rnt_...",
  "projectId": "prj_...",
  "expiresAt": "2026-09-09T12:10:00.000Z"
}
```

The local Runtime redeems both the pairing identifier and `pairingCode` through:

```http
POST /v1/runtime-pairings/{pairingId}/redeem
Content-Type: application/json

{
  "pairingCode": "XXXX-XXXX-XXXX-XXXX-XXXX",
  "machineName": "build-mac",
  "workspaceName": "workspace",
  "agents": [],
  "installableAgents": []
}
```

A redemption succeeds exactly once and returns
`{"channelId":"...","runtimeCredential":"...","runtimeId":"..."}`.
The Runtime then connects to `WSS /v1/runtimes/connect` with
`Authorization: Bearer <runtimeCredential>`; the credential is never placed in
the public WebSocket URL. Its authenticated catalog, reconciliation, and artifact
HTTP requests use the same header-only credential transport. Replaying a claimed or expired code returns
`invalid_pairing_code` and never issues another credential.

An owner can inspect the lifecycle without exposing `pollToken` in a URL:

```http
GET /v1/projects/{projectId}/runtime-pairings/{pairingId}
Authorization: Bearer <project-owner-credential>
```

Responses use the concrete `pending`, `paired`, `expired`, and `revoked`
lifecycle shapes. A paired response includes that Runtime's machine metadata
and current Agent catalogs. Pairing records expire after ten minutes.

The Project has a bounded quota of eight active `pending` or `paired`
Runtimes. Expired and revoked records release their slot. An additional request
returns `runtime_quota_exceeded` with HTTP 429 while the quota is full.

## Listing, selection, and revocation

`GET /v1/projects/{projectId}/runtimes` returns all paired Runtimes in the Project.
Online state comes from each Runtime's own Durable Object and is not shared.
Session creation, Session rebinding, import, and Turn dispatch reauthorize the
selected `runtimeId` against the authenticated Project.
A Runtime from another Project fails with `runtime_access_denied` or
`binding_incompatible` before work is accepted. Binding creation never sends a
local approval request.

Revoke exactly one Runtime:

```http
DELETE /v1/projects/{projectId}/runtimes/{runtimeId}
Authorization: Bearer <project-owner-credential>
```

Revocation is idempotent. It invalidates that Runtime's daemon credential,
closes its active daemon and Channel host sockets, expires Channel access
grants. Other Runtimes, Sessions, and daemon connections are unchanged. Work
remains pinned to its recorded Runtime and binding revision; Mobius does not fail over
or migrate work to another machine.

The first Runtime can be revoked without losing Project administration because
the owner credential is persisted in `project_owner_credentials`, independently
of every Runtime Channel lifecycle.

## TypeScript SDK

`@moxt-ai/mobius-sdk` exposes creation and owner status reads through
`client.runtimePairings`, and listing and revocation through `client.runtimes`:

```ts
import { MobiusRuntimePairingRequest } from "@moxt-ai/mobius-sdk";

const request = new MobiusRuntimePairingRequest(crypto.randomUUID());
const pairing = await ownerClient.runtimePairings.create(request, signal);
const status = await ownerClient.runtimePairings.read(pairing.pairingId, signal);
const runtimes = await ownerClient.runtimes.list(signal);
await ownerClient.runtimes.revoke(pairing.runtimeId, signal);
```

See the [TypeScript SDK guide](typescript-sdk.md#pair-and-revoke-project-runtimes)
for concrete lifecycle classes and credential guidance.

## Audit and storage

D1 stores only hashes of pairing, polling, owner, host, and Runtime secrets.
`runtime_pairing_audit_events` records `requested`, `claimed`, `expired`,
`revoked`, and `rejected` outcomes with Project, pairing, Runtime, actor, and
timestamp correlation. Public errors are sanitized; executable paths,
workspace paths, provider credentials, and daemon credentials never enter the
pairing request.

Migration `0004_project_runtime_pairings.sql` preserves existing
`pairing_channels` rows, backfills their Runtime slots and explicit owner
credentials, and adds indexed Project/Runtime lookup, idempotency, quota, and
audit storage.
