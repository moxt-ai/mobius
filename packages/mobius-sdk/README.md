---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Mobius TypeScript SDK

### Bring your users' coding Agents into your app.

Build a web or mobile interface to Codex, Claude Code, and Pi running on your
users' computers. Let users send instructions, watch live replies and tool activity,
and continue conversations from another device, while execution stays in the
environment where their projects and tools already live.

**You build the product experience. Mobius connects it to the Agent.**

[Start integrating](#start-building)
· [See a real application: Morty](https://github.com/moxt-ai/morty)

## Why use Mobius?

- **Integrate once across Agents.** Give your application a shared TypeScript
  interface for session interaction across supported Agents. Discover each
  connected machine's Agents and settings instead of hardcoding one setup.
- **Reach the user's existing workspace.** Pair their machine and work with its
  local projects, tools, and Agent sessions. Users keep working in their own
  development environment.
- **Ship an interactive Agent experience.** Stream replies and tool activity,
  send follow-up instructions, stop execution, respond to supported permission
  requests, and transfer attachments through the same integration.
- **Connect multiple views of the same work.** Let users watch a conversation
  from more than one client and return to the history and current-turn information
  available when they reconnect.

Use it to build a remote coding companion, add local Agent conversations to your
developer product, or give a team a shared view of ongoing Agent work.

## See what you can build

[**Morty**](https://github.com/moxt-ai/morty) uses Mobius to provide browser chat
with local coding Agents, streamed responses, attachments, and conversation
history. Build your own interface and workflows on the same SDK.

```text
Your app → Mobius SDK → Relay → Local daemon → Coding Agent
```

The Relay connects your app to the paired machine. The local daemon runs there
and adapts its Agents. Your application owns its interface and access policies;
local actions are authorized on the connected machine. Available operations
depend on the selected Agent and its configuration.

## Start building

```sh
npm install @moxt-ai/mobius-sdk
```

Use the hosted Mobius service or deploy the Relay to your own Cloudflare account.
Provision a Project, pair a machine with an installed and authenticated Agent,
then connect your application. Installing this package is the first step;
the Agent runs on the paired machine.

### Make your first SDK request

From the [Platform app](https://mobius.moxt.ai/), obtain an AppCredential authorized
for your Project. Pair a Runtime with that Project to see an online machine in
the response. Save these values in a local `.env` file:

```dotenv
MOBIUS_ENDPOINT=https://mobius.moxt.ai
MOBIUS_PROJECT_ID=your-project-id
MOBIUS_APP_CREDENTIAL=your-app-credential
```

Save this as `list-runtimes.mjs` beside your application's `package.json`:

```js
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";

const endpoint = process.env.MOBIUS_ENDPOINT;
const projectId = process.env.MOBIUS_PROJECT_ID;
const credential = process.env.MOBIUS_APP_CREDENTIAL;
if (!endpoint || !projectId || !credential) {
    throw new Error("Set MOBIUS_ENDPOINT, MOBIUS_PROJECT_ID, and MOBIUS_APP_CREDENTIAL.");
}

const client = new MobiusClient({
    endpoint,
    projectId,
    credentialProvider: new StaticMobiusCredentialProvider(credential),
});

try {
    const runtimes = await client.runtimes.list(AbortSignal.timeout(10_000));
    console.log(JSON.stringify(runtimes, null, 2));
} finally {
    client.close();
}
```

Run it with Node.js 24:

```sh
node --env-file=.env list-runtimes.mjs
```

The response includes Runtime IDs, online status, and Agent descriptors. An empty
array means that Project has no paired machines. Use your deployment's endpoint
instead when running your own Relay.

### Run the complete session example

The [mini-client source](https://github.com/moxt-ai/mobius/blob/main/packages/mini-client/index.ts)
shows the actual SDK calls for pairing, creating a Session, submitting prompts,
reading history, and subscribing to live output. It is an executable repository
example, with its own CLI and isolated Runtime state.

```sh
git clone https://github.com/moxt-ai/mobius.git
cd mobius
pnpm install
cd packages/mini-client
pnpm exec tsx ./index.ts --help
```

Use the Node and pnpm versions pinned by the repository. Install and authenticate
at least one supported Agent on the machine that will run the example.

<details>
<summary>Pair a Runtime, create a Session, send a prompt, and clean up</summary>

Start the local Platform from a second terminal at the repository root:

```sh
pnpm dev
```

Provision an App and AppCredential in that local Platform before continuing.
The default endpoint is `http://127.0.0.1:8787`. Use the provisioning functions
linked below with your deployment's configured OIDC identity. For a different
endpoint, add `--endpoint=https://your-relay.example` to `create`.

Run the remaining commands from `packages/mini-client`. Its state directory
holds credentials and identifiers for this example; keep it private and do not commit it.

#### Create and pair an isolated Runtime

Keep secrets out of shell history where possible:

```sh
read -r MOBIUS_TEST_APP_ID
read -rs MOBIUS_TEST_APP_SECRET
printf '\n'
export MOBIUS_TEST_APP_ID MOBIUS_TEST_APP_SECRET

MOBIUS_MINI_CREATE="$(pnpm exec tsx ./index.ts \
  create \
  --app-id="$MOBIUS_TEST_APP_ID" \
  --app-secret="$MOBIUS_TEST_APP_SECRET")"
printf '%s\n' "$MOBIUS_MINI_CREATE"
export MOBIUS_MINI_STATE="$(printf '%s' "$MOBIUS_MINI_CREATE" | node -e \
  'let value=""; process.stdin.on("data", chunk => value += chunk).on("end", () => process.stdout.write(JSON.parse(value).stateDir))')"
```

`create` pairs an isolated Runtime and waits until it is online. It prints the generated `stateDir` and identifiers, but never the credential. Pass `--state-dir` only for a directory owned by this verification workflow.

Inspect the Runtime and available Agents:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" status
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" list-runtimes
```

#### Create and configure a Session

When the Runtime advertises more than one Agent, pass the selected Agent ID:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  create-session \
  --agent=codex \
  --title="Mini-client verification"
```

Save the returned `sessionId`, then inspect and update a setting offered in `configOptions`:

```sh
export MOBIUS_TEST_SESSION='<sessionId>'

pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get-agent-configuration \
  --session="$MOBIUS_TEST_SESSION"

pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  update-agent-configuration \
  --session="$MOBIUS_TEST_SESSION" \
  --config-id='<offered-config-id>' \
  --value='<offered-value>'
```

Boolean settings accept only `true` or `false`. Select settings accept only values advertised by the Agent.

#### Prompt, steer, and reconcile messages

Follow the Session in one terminal to see available history and new live events. Live delivery is best effort; disconnects or restarts can leave gaps.

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get \
  --session="$MOBIUS_TEST_SESSION" \
  --follow
```

Before the first prompt, `--follow` watches the Session until you press Ctrl-C.
After a prompt has been submitted through this mini-client, it follows that
command and exits when its terminal outcome is observed. It also checks the
Runtime's execution receipt when connecting, so an already completed command
does not require a new live completion event. Older Runtimes that do not return
command receipts may require Ctrl-C if their completion event was missed.

In another terminal, start a Turn:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  send-prompt \
  --session="$MOBIUS_TEST_SESSION" \
  --prompt='Write a short checklist and keep working until it is complete.'
```

While that Turn is running, steer it:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  steer \
  --session="$MOBIUS_TEST_SESSION" \
  --prompt='Make the final checklist exactly three items.'
```

To exercise queueing instead, submit with `--disposition=queue`. Queueing and steering require an active Turn submitted through this mini-client.

After completion, read a finite reconciled snapshot and confirm that the original prompt, steering prompt, and Agent result appear once:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get \
  --session="$MOBIUS_TEST_SESSION"
```

Other useful operations are:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" compact --session="$MOBIUS_TEST_SESSION"
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" list-sessions
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" cancel-turn --session="$MOBIUS_TEST_SESSION" --turn='<turnId>'
```

`compact` submits the Agent's advertised compact command. If the selected Agent does not offer compaction, it exits with `compact_unavailable` without sending a prompt.

#### Stop, resume, and clean up

`stop` addresses the detached Runtime by its opaque Connection ID; it does not signal a recorded PID:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" stop
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" status
```

Resume the same saved Runtime when needed:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" start
```

At the end, stop it and remove the isolated state:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" stop
MOBIUS_STATE_DIRECTORY="$MOBIUS_MINI_STATE/runtime" pnpm --dir ../.. mobius quit
rm -rf -- "$MOBIUS_MINI_STATE"
```

Only remove a state directory created specifically for this workflow.

</details>

For programmatic provisioning, see
[`moxt-server.ts`](https://github.com/moxt-ai/mobius/blob/main/packages/mobius-sdk/examples/moxt-server.ts).
It exports provisioning functions for your backend to call; it is not a
standalone script. Supply an authorized OIDC identity and a credential vault
implementation as shown by its function parameters.

### Choose your entrypoint

| What you are building | Import |
| --- | --- |
| A live Agent conversation interface | `@moxt-ai/mobius-sdk/channel` |
| Backend pairing, Runtime discovery, and session operations | `@moxt-ai/mobius-sdk/server` |
| App and Project provisioning | `@moxt-ai/mobius-sdk/platform` |

Keep server credentials on your backend. Give browser clients credentials scoped
to their authorized access.

## History and reconnects

Native history comes from the connected machine and what its Agent has saved.
Optional cloud Recording can make recorded history available while the machine
is offline, according to the configured policy. Clients must follow that source
instead of assuming history is always local or always retained.

Multiple clients can watch the same conversation, including instructions submitted
elsewhere. Publishing continues without viewers. Ordinary updates carry changed
content rather than repeated full-turn snapshots; joining or reconnecting may
require a full current-turn view.

Live output is best effort. Disconnected or overloaded viewers can miss events,
and daemon or Relay restarts can lose in-flight messages. Clients reconcile from
available current-turn information, native history, or Recording. Reconnecting
cannot guarantee recovery of every lost event. Use the
[prompt identity contract](https://github.com/moxt-ai/mobius/blob/main/docs/protocol.md#prompt-identity-across-http-and-daemon-apis)
to target cancellation and steering when the original submission response is unavailable.

Pairing and Session metadata may remain on disk, and Agents own their native history.
Current-turn content and pending work remain in daemon memory; restarting the daemon
loses them and does not resume running work or queued prompts. Disabling Recording
does not erase native Agent history or local metadata.

Recording never blocks live output. Slow writes, failures, or restarts can leave
gaps; failed writes are not retried. It is not a lossless audit archive and does
not keep an offline Agent running.

Images are fetched from the connected machine when needed, so large encoded images
do not delay the conversation. Temporary media files are a disposable cache rather
than saved conversations. Eviction or a restart may make them unavailable; recovery
depends on the connected machine and what native history retained. See
[persistence and recovery constraints](https://github.com/moxt-ai/mobius/blob/main/docs/CONTRIBUTING.md#persistence-and-recovery-constraints)
and [image delivery constraints](https://github.com/moxt-ai/mobius/blob/main/docs/CONTRIBUTING.md#image-delivery-constraints).

## Connection and provisioning notes

Agent catalogs belong to a Runtime. Read one with
`client.runtimes.getAgents(runtimeId, signal)`. Discover that Agent's settings with
`client.runtimes.discoverAgentSettings(runtimeId, agentId, request, signal)` and
pass the selected values when prompting through the live channel.

For a live Runtime connection, pass an asynchronous `relayUrl` provider to
`connectMobiusChannelClient`. It runs before the initial connection and each
reconnect, so it can call `credentials.credential(signal)` and put the current
token in the Runtime host URL. Closing the channel client aborts an in-flight
URL refresh through the supplied signal.

Server clients use `HttpTransport` by default. A shared `WsTransport` can tunnel
HTTP requests through `/mobius/api/v1/transport`; its owner closes it when finished.
The channel client manages its own WebSocket connection.

## AppCredential issuance and recovery

`createApp`, `issueAppCredential`, and `rotateAppCredential` return new secrets once
without idempotent result replay. Save successful secrets before continuing.
A timeout or lost response can happen after a write committed; reconcile the
outcome before retrying.

<details>
<summary>Retry contracts, rotation, and recovery of an uncertain outcome</summary>

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

#### Recovering an unknown outcome

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

Confirm an unused credential with the integration owners and their deployed
configuration before revoking it. Usage timestamps are best-effort observations,
not a complete audit trail. A missing or old observation does not prove inactivity;
the legacy last-use timestamp can also contain the issuance time before any use.
Do not use these values alone to decide that a credential is safe to revoke.

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

</details>

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
