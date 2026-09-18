# Mobius TypeScript SDK

Unified public Relay client for modern browsers and Node.js 20.19 or later. It
exposes resource-oriented Runtime pairing, Runtime, Session, Turn, Attempt, Event, Interaction,
history, Artifact, credential, portability, and provider-neutral Bot connector
operations without exposing Relay storage or deployment details.

```sh
pnpm add @moxt-ai/mobius-sdk
```

See the [TypeScript SDK guide](https://github.com/moxt-ai/mobius/blob/main/docs/typescript-sdk.md)
and the repository [Node](https://github.com/moxt-ai/mobius/blob/main/packages/mobius-sdk/examples/node.ts)
and [browser](https://github.com/moxt-ai/mobius/blob/main/packages/mobius-sdk/examples/browser.ts)
reference implementations. They share one resource workflow but are not part
of the published SDK API. The [Bot connector
guide](https://github.com/moxt-ai/mobius/blob/main/docs/bots.md) documents grant
redemption, scoped credentials, connected conversations, cursor recovery,
outbound acknowledgement, and connection revocation.

Project authorization, accountless recovery, and owner credential rotation
are documented in the [Project authentication
guide](https://github.com/moxt-ai/mobius/blob/main/docs/project-authentication.md).
The server-only
[`moxt-server`](https://github.com/moxt-ai/mobius/blob/main/packages/mobius-sdk/examples/moxt-server.ts)
example provisions a Platform App and Project using `@moxt-ai/mobius-sdk/platform`,
then uses Project-scoped clients for Runtime and Bot management, conversation
work, and event projection. App lifecycle and AppCredentials belong to the
Platform SDK entry point only.

SDK clients use `HttpTransport` by default. Supply one shared `WsTransport`
instance to a client's `transport` option to tunnel repeated request/response
operations over a persistent Platform WebSocket at `/mobius/api/v1/transport`:

```ts
const transport = new WsTransport();
const client = new MobiusClient({ endpoint, projectId, credentialProvider, transport });
```

Call `transport.close()` when its owner releases the client. The WebSocket
transport preserves each request's authorization headers and supports JSON and
binary request/response bodies. Session event streams remain on `HttpTransport`.

Bot execution bindings require an `AgentExecutionConfiguration` containing a
permission mode, model selection, and reasoning-effort selection. Discover the
authoritative choices with `client.runtimes.discoverAgentSettings(...)`, then
pass the selected values to `MobiusBotOwnerClient.createBinding(...)`. See the
[TypeScript SDK guide](https://github.com/moxt-ai/mobius/blob/main/docs/typescript-sdk.md#required-bot-execution-settings)
for the Platform/Moxt flow.

Existing users of `MobiusProjectAuthenticationClient.applications` and
`.applicationCredentials` should migrate to `MobiusPlatformDeveloperClient`.
The [migration table](https://github.com/moxt-ai/mobius/blob/main/docs/project-authentication.md#migrating-app-management-to-platform)
maps each operation to its Platform SDK method and HTTP endpoint, including
Tenant ownership, Project scope, and credential lifecycle differences.
