# Mobius TypeScript SDK

The SDK connects browser and server clients to a Mobius Relay. It supports Runtime pairing, Runtime discovery, native Agent sessions, browser credentials, and the live Runtime channel. Native session history stays on the user's machine; Mobius does not expose cloud Session, Turn, Attempt, or message history resources.

```sh
pnpm add @moxt-ai/mobius-sdk
```

Use `@moxt-ai/mobius-sdk/channel` for the live browser channel, `@moxt-ai/mobius-sdk/server` for project Runtime and pairing operations, and `@moxt-ai/mobius-sdk/platform` for Platform provisioning. Standalone Relay does not require Platform provisioning.

Server clients use `HttpTransport` by default. A shared `WsTransport` can tunnel HTTP requests through the Relay's `/mobius/api/v1/transport` endpoint; its owner closes the transport when finished. The channel client manages its own WebSocket connection.

Agent catalogs belong to a Runtime. Read one with `client.runtimes.getAgents(runtimeId, signal)`. Agent settings belong to the selected Runtime and Agent. Discover them with `client.runtimes.discoverAgentSettings(runtimeId, agentId, request, signal)` and pass the selected values to the live channel when prompting.
