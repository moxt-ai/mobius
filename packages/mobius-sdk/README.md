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

[Start integrating](https://github.com/moxt-ai/mobius/blob/main/docs/GUIDE.md#start-with-the-sdk)
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

**[Follow the integration guide →](https://github.com/moxt-ai/mobius/blob/main/docs/GUIDE.md#start-with-the-sdk)**

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

Use the Node and pnpm versions pinned by the repository. Then follow the
[mini-client walkthrough](https://github.com/moxt-ai/mobius/blob/main/packages/mini-client/README.md)
to supply an App ID and credential, pair a machine, choose an installed Agent,
create a Session, send a prompt, and inspect the result. The walkthrough also
shows how to stop the isolated Runtime after trying it.

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
to their authorized access, as described in the integration guide.

## History and reconnects

Native history comes from the connected machine. You can also enable optional
cloud Recording to read recorded history while that machine is offline.
Recording is best effort, and reconnecting cannot guarantee recovery of every
event lost during an interruption. Follow the configured history source and
[recovery boundaries](https://github.com/moxt-ai/mobius/blob/main/docs/GUIDE.md#data-ownership-and-recovery).

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

Platform `createApp`, `issueAppCredential`, and `rotateAppCredential` return new
secrets once without idempotent result replay. The SDK does not retry them
automatically. A timeout or lost response can happen after the write committed;
save successful secrets and reconcile uncertain outcomes before retrying.
See [AppCredential issuance and recovery](https://github.com/moxt-ai/mobius/blob/main/docs/GUIDE.md#appcredential-issuance-and-recovery).
