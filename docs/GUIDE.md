---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Integrating and operating Mobius

This guide covers integration prerequisites, a backend SDK example, local Runtime
management, and delivery and recovery boundaries. For the product overview, see
[README.md](../README.md). For changes to Mobius itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it fits together

```text
Your application
      │
  Mobius SDK
      │
  Mobius Relay
      │
  Mobius daemon ── Coding Agent
  on the user's machine
```

- **SDK:** TypeScript clients for application backends and browsers, including Runtime
  pairing and discovery, session operations, credentials, and live connections.
- **Relay:** connects applications to paired Runtimes and routes authorized requests
  and live output between them.
- **Daemon:** runs on the connected machine and adapts local Agents while preserving
  their native tools and environment. A Runtime is the paired execution endpoint your
  application connects to.

Mobius includes management interfaces for pairing, Runtime management, and Agent
configuration. The conversation UI belongs to the application you build.

[Morty](https://github.com/moxt-ai/morty) is one application built on Mobius. It provides
its own Bot model, browser chat, and conversation history experience. You can integrate
Mobius directly without adopting Morty.

## Start with the SDK

Install the TypeScript SDK in your application:

```sh
npm install @moxt-ai/mobius-sdk
```

For a backend connection, you need a Mobius endpoint, a provisioned Project ID, and an
AppCredential authorized for that Project. To discover local Agents, pair a Runtime
with the Project and install and authenticate the Agents on that machine first.
Installing the SDK alone does not provision these resources.

The [Platform app](https://mobius.moxt.ai/) manages organizations, Apps, and server
credentials. See the [server provisioning example](../packages/mobius-sdk/examples/moxt-server.ts)
for creating an App and Project programmatically and storing the returned credential.

This server-side example lists the Project's paired Runtimes and their Agent catalogs:

```ts
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";

const endpoint = process.env.MOBIUS_ENDPOINT;
const projectId = process.env.MOBIUS_PROJECT_ID;
const appCredential = process.env.MOBIUS_APP_CREDENTIAL;
if (!endpoint || !projectId || !appCredential) {
    throw new Error("Set MOBIUS_ENDPOINT, MOBIUS_PROJECT_ID, and MOBIUS_APP_CREDENTIAL.");
}

const client = new MobiusClient({
    endpoint,
    projectId,
    credentialProvider: new StaticMobiusCredentialProvider(appCredential),
});

try {
    const runtimes = await client.runtimes.list(AbortSignal.timeout(10_000));
    for (const runtime of runtimes) {
        console.log(runtime.runtimeId, runtime.online, runtime.agents);
    }
} finally {
    client.close();
}
```

Run it in your Node.js backend with those environment variables set. A successful
request prints the Runtime IDs, online status, and available Agent descriptors. An
empty list means the Project has no paired Runtimes. Keep the AppCredential on your
server; browser clients must receive credentials scoped to their authorized access.

For a complete development workflow without Morty, follow the
[mini-client walkthrough](../packages/mini-client/README.md). It pairs an isolated Runtime
and exercises sessions against a local Platform. It is a repository development tool,
not a dependency your application needs to adopt.

The [SDK guide](../packages/mobius-sdk/README.md) covers server, Platform, and live-channel
entrypoints, transport ownership, and credential refresh. Agent catalogs and settings
are discovered from the selected Runtime rather than assumed to be identical across
machines.

## AppCredential issuance and recovery

The Platform developer client's `createApp`, `issueAppCredential`, and
`rotateAppCredential` operations return a new secret only in their successful
response. "Returned once" describes secret delivery, not a single-use credential:
the credential remains usable until revoked, its rotation overlap ends, or its App
or Tenant becomes unavailable. The Platform stores a digest, so listing Apps or
credentials cannot recover the secret.

These operations do not provide idempotent result replay. The SDK does not retry
them automatically; custom transports, proxies, and application retry policies must not blindly replay
them either. `createProject` has its own idempotency contract, which does not extend
to the App or credential operations around it.

| Operation | Successful result | Repeating the same request |
| --- | --- | --- |
| `createApp` | Creates an App and its default credential, returning the secret. | The Tenant's unique display-name constraint rejects a same-name create while that name is occupied; it does not replay the first result. Renaming the existing App or using a different name can allow another App to be created. |
| `issueAppCredential` | Creates a credential with the requested permissions and Project scope, returning the secret. | Can create another credential. The earlier credential is not automatically invalidated. |
| `rotateAppCredential` | Creates a replacement with the source credential's permissions and scope and starts the source's requested overlap. | An already rotated or revoked source returns `409 app_credential_rotation_conflict`; it does not return the replacement secret. |

A successful response means the operation committed. Save the secret and its
credential ID to your secret store before starting unrelated work. If that local
save fails but you still have the response, retry saving that same result. Creating
another credential cannot recover the first secret.

A connection failure, timeout, cancellation after dispatch, or unusable response
can occur after the write committed. An error, including a server error, is not
proof that nothing was written. Cancelling a request does not guarantee rollback.
Inspect the stored result before deciding on another write; an immediate list
without a new record also cannot prove an in-flight request will never commit.

### Recovering an unknown outcome

Use an authorized `MobiusPlatformDeveloperClient` for reconciliation. It can list
and administer credentials without knowing their secrets. Coordinate App creation
within a Tenant and credential administration within an App, retaining known
resource IDs and the results you have already saved.

For creation and issuance, there is no request identifier that reliably associates
a lost response with a record. `listApps`, `listAppCredentials`, and
`listAuditEvents` can help an operator identify committed work. An App name is unique
within its Tenant, but is mutable and does not identify which caller created it;
timestamps and matching credential scopes are not request identities either. If
other writers or in-flight requests make ownership uncertain, stop automatic recovery and
reconcile with the operators involved. Do not revoke or rotate an arbitrary new
credential or assume a missing list entry makes a retry safe.

- **Lost `createApp` response:** after confirming which App was created, use its
  `defaultCredentialId` and `listAppCredentials` to locate the credential. Rotate
  that credential to obtain and save a replacement secret. If it was already
  rotated, inspect the replacement chain first. Changing the requested name to get
  past a failed create can leave the original App and credential behind.
- **Lost `issueAppCredential` response:** after identifying the issued credential,
  rotate it and save the replacement secret. Rotation preserves its permissions and
  Project scope. Alternatively, revoke a confirmed unused credential before
  deliberately issuing a new one. Reissuing alone does not clean up the first one.
- **Lost `rotateAppCredential` response:** list the App's credentials and inspect
  the known source's `replacedByCredentialId`. A replacement link establishes that
  rotation committed, but does not identify which concurrent caller won. If the
  replacement secret was lost, coordinate with other administrators, follow any
  further replacement links, and rotate the confirmed active replacement once to
  obtain a new secret. A revoked credential has no recoverable secret. A conflict
  without a replacement link is not proof of successful rotation; investigate
  revocation or concurrent work before issuing a new credential.

Use zero overlap when replacing a confirmed lost, unused secret so that credential
immediately stops authorizing new requests. Earlier credentials in a rotation chain
retain their own overlap deadlines; rotating the latest replacement does not
shorten those deadlines. After saving the usable replacement, explicitly revoke
earlier credentials if they should stop working sooner, coordinating any users
still relying on them. If the recovery response is also lost, reconcile again
instead of looping through blind writes.

## Live output and recovery

Ongoing work should feel like a live broadcast. Multiple devices can watch the same
conversation and see instructions sent from elsewhere. Publishing continues when
nobody is watching. Ordinary updates carry new or changed content, so processing and
transfer grow with the content produced rather than repeated copies of the entire
turn. Joining or reconnecting may require a full current-turn view; that catch-up cost
must not recur on every update.

Mobius chooses responsive live output and a simple lifecycle over guaranteed delivery.
Disconnected or overloaded viewers can miss events, and daemon or Relay restarts can
lose in-flight messages. Reconnecting resumes the broadcast; clients catch up through
the available current-turn view, native Agent history, or optional cloud Recording.
Restarting the daemon does not resume running work or queued prompts.

When reconnecting or observing another client's prompts, use the
[prompt identity contract](protocol.md#prompt-identity-across-http-and-daemon-apis)
to target cancellation and steering from the current execution view, even when
the original submission response is unavailable.

Recording is best effort: slow writes, failures, or restarts can leave gaps. It must
never block live output, and failed writes are not retried. Recording is not a
lossless audit archive and does not keep an offline Agent running.

## Data ownership and recovery

Without cloud Recording, history depends on the connected machine and what its Agent
has saved. Recording retains cloud history according to the configured policy.

Pairing and session metadata may be stored locally, and Agents manage their own native
history. Current-turn content and pending work must remain in daemon memory;
restarting the daemon loses them. Disabling Recording does not erase Agent history
or local metadata. See [persistence and recovery constraints](CONTRIBUTING.md#persistence-and-recovery-constraints).

Images should be fetched from the connected machine when needed, so large embedded
images do not delay the conversation. Temporary image files are a disposable media
cache, not saved conversations; their availability depends on the connected machine
and retained Agent history. See [image delivery constraints](CONTRIBUTING.md#image-delivery-constraints).

## Manage local Runtime connections

Pairing starts or reuses one detached Mobius manager for the current user. If the
installed CLI version changes, the next `mobius pair` or `mobius start` command
stops the old manager and launches the matching version.

With the CLI installed, run `mobius start` without options to ensure the detached
daemon is running. Manage saved Runtime pairings by their local Connection ID:

```sh
mobius pair list
mobius pair stop --connection <connection-id>
mobius start
mobius start --connection <connection-id>
mobius pair remove --connection <connection-id>
mobius quit
```

Stopping preserves the pairing and its `stopped` status across manager restarts.
Starting resumes the same Connection ID; removing deletes its local credential.
`mobius pair list` shows the Connection ID, Platform App ID, Runtime ID, workspace,
and current status. Channel IDs are internal Relay routing identities, not local
lifecycle selectors.

For machine-readable output, use `mobius pair list --output-json=/path/to/existing-file.json`.
The CLI refuses to create the target; command help and executable scenarios define
its output contract.
