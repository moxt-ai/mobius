# Mobius TypeScript SDK

Unified public Relay client for modern browsers and Node.js 20.19 or later. It
exposes resource-oriented Runtime pairing, Runtime, Session, Turn, Attempt, Event, Interaction,
history, Artifact, credential, portability, and provider-neutral Bot connector
operations without exposing Relay storage or deployment details.

```sh
pnpm add @moxt-ai/mobius-sdk
```

See the [TypeScript SDK guide](https://github.com/moxt-ai/mobius/blob/main/docs/typescript-sdk.md)
and the runnable [Node](https://github.com/moxt-ai/mobius/blob/main/packages/web-sdk/examples/node.ts)
and [browser](https://github.com/moxt-ai/mobius/blob/main/packages/web-sdk/examples/browser.ts)
examples. Both entry points execute the same shared resource workflow. The
browser and shared workflow modules are also exported as
`@moxt-ai/mobius-sdk/examples/browser` and
`@moxt-ai/mobius-sdk/examples/workflow`. The packaged Node entry point is
`@moxt-ai/mobius-sdk/examples/node`. The [Bot connector
guide](https://github.com/moxt-ai/mobius/blob/main/docs/bots.md) documents grant
redemption, scoped credentials, connected conversations, cursor recovery,
outbound acknowledgement, and connection revocation.

Project application registration, OIDC exchange, accountless recovery, and
credential rotation are documented in the [Project authentication
guide](https://github.com/moxt-ai/mobius/blob/main/docs/project-authentication.md).
The server-only
[`moxt-server`](https://github.com/moxt-ai/mobius/blob/main/packages/web-sdk/examples/moxt-server.ts)
example provisions separate least-privilege application credentials for Runtime
and Bot management, conversation work, and event projection without creating a
Bot Connection.
