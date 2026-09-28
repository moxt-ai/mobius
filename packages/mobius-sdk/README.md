# Mobius TypeScript SDK

The SDK connects browser and server clients to a Mobius Relay. It supports Runtime pairing, Runtime discovery, native Agent sessions, browser credentials, and the live Runtime channel. Native session history stays on the user's machine; Mobius does not expose cloud Session, Turn, Attempt, or message history resources.

```sh
pnpm add @moxt-ai/mobius-sdk
```

Use `@moxt-ai/mobius-sdk/channel` for the live browser channel, `@moxt-ai/mobius-sdk/server` for project Runtime and pairing operations, and `@moxt-ai/mobius-sdk/platform` for Platform provisioning. Standalone Relay does not require Platform provisioning.

Server clients use `HttpTransport` by default. A shared `WsTransport` can tunnel HTTP requests through the Relay's `/mobius/api/v1/transport` endpoint; its owner closes the transport when finished. The channel client manages its own WebSocket connection.

Agent catalogs belong to a Runtime. Read one with `client.runtimes.getAgents(runtimeId, signal)`. Agent settings belong to the selected Runtime and Agent. Discover them with `client.runtimes.discoverAgentSettings(runtimeId, agentId, request, signal)` and pass the selected values to the live channel when prompting.

## Standalone browser apps

Use `MobiusStandaloneCredentialProvider` in a browser served by the Standalone
Worker. It exchanges the public bootstrap endpoint for a short-lived credential and
keeps the deployment owner credential inside the Worker. All Mobius HTTP operations
then go through the ordinary SDK client:

```ts
import {
    MobiusClient,
    MobiusRuntimePairingRequest,
    MobiusStandaloneCredentialProvider,
} from "@moxt-ai/mobius-sdk";

const endpoint = window.location.origin;
const credentials = new MobiusStandaloneCredentialProvider({ endpoint });
const mobius = new MobiusClient({
    credentialProvider: credentials,
    endpoint,
    projectId: "standalone",
});

const pairing = await mobius.runtimePairings.create(
    new MobiusRuntimePairingRequest(`web-${crypto.randomUUID()}`),
    AbortSignal.timeout(15_000),
);

const runtimes = await mobius.runtimes.list(AbortSignal.timeout(15_000));
```

The provider refreshes its cached credential before expiry. Keep one provider for the
browser app and pass cancellation signals to every operation. Do not call the
Standalone bootstrap endpoint directly or copy the deployment owner credential into
browser configuration. Apps that hold a channel-owner credential can manage channel
access grants through `client.channels`; one-time grant redemption uses
`MobiusChannelAccessClient`.

For a live Runtime connection, pass an asynchronous `relayUrl` provider to
`connectMobiusChannelClient`. The SDK evaluates it for the initial connection and
again before every reconnect, so the callback can call `credentials.credential(signal)`
and place the current token in the Runtime host URL. Closing the channel client aborts
an in-flight URL refresh through the supplied signal.
