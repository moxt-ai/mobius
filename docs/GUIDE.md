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
