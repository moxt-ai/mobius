# Mobius TypeScript SDK

The SDK connects browser and server clients to a Mobius Relay. It supports Runtime pairing, Runtime discovery, native Agent sessions, browser credentials, and the live Runtime channel. Native history is supplied by the local Runtime. Deployments can also install and enable optional cloud Recording; clients must respect the configured history source rather than assume that history is always local or always retained. See [data ownership and recovery](../../README.md#data-ownership-and-recovery).

```sh
pnpm add @moxt-ai/mobius-sdk
```

Use `@moxt-ai/mobius-sdk/channel` for the live browser channel, `@moxt-ai/mobius-sdk/server` for project Runtime and pairing operations, and `@moxt-ai/mobius-sdk/platform` for Platform provisioning.

Server clients use `HttpTransport` by default. A shared `WsTransport` can tunnel HTTP requests through the Relay's `/mobius/api/v1/transport` endpoint; its owner closes the transport when finished. The channel client manages its own WebSocket connection.

Agent catalogs belong to a Runtime. Read one with `client.runtimes.getAgents(runtimeId, signal)`. Agent settings belong to the selected Runtime and Agent. Discover them with `client.runtimes.discoverAgentSettings(runtimeId, agentId, request, signal)` and pass the selected values to the live channel when prompting.

For a live Runtime connection, pass an asynchronous `relayUrl` provider to
`connectMobiusChannelClient`. The SDK evaluates it for the initial connection and
again before every reconnect, so the callback can call `credentials.credential(signal)`
and place the current token in the Runtime host URL. Closing the channel client aborts
an in-flight URL refresh through the supplied signal.
