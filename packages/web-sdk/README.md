# Mobius TypeScript SDK

Unified public Relay client for modern browsers and Node.js 20.19 or later. It
exposes resource-oriented Runtime, Session, Turn, Attempt, Event, Interaction,
history, Artifact, credential, and portability operations without exposing
Relay storage or deployment details.

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
`@moxt-ai/mobius-sdk/examples/node`.
