# Agent and daemon integration tests

These tests treat a real third-party Agent and the production Mobius daemon as
one system. They drive and observe that system only through the production
protocol between the daemon and a local Mobius server.

```text
test client
    |
    | Mobius server protocol
    v
local Mobius server <-> production daemon <-> ACP <-> real Agent
                                                        |
                                                        | provider protocol
                                                        v
                                               local fake LLM provider
```

The fake provider replaces only the hosted model. The Agent executable, its
normal configuration, its provider client, the ACP adapter, the daemon, and the
server protocol path are real production code.

## What a case proves

A case must show that:

1. the daemon discovers and starts the real Agent executable;
2. the Agent uses its supported configuration to connect to a loopback fake
   provider;
3. a prompt submitted through the server protocol completes; and
4. the response returned through ACP is visible in persisted server history.

Do not drive the scenario by calling Agent discovery, `AcpSessionManager`, an
ACP client, or the Agent executable from the test. Those are internal links in
the path being proved.

The fake provider is a permissive executable dependency, not a request mock.
Its job is to let the real Agent work without hosted credentials. It should
implement the smallest valid provider response. The distinctive response that
returns through ACP and server history proves that the Agent connected. Do not
assert the Agent's request path, headers, payload shape, prompt rewriting, or
auxiliary model calls unless Mobius itself depends on that behavior.

## Layout

```text
tests/agent-daemon/
  README.md
  cases/
    codex.integration.test.ts
    opencode.integration.test.ts
  infra/
    codex.ts
    executable.ts
    opencode.ts
  providers/
    openai.ts
```

The case file is the control surface: it shows the whole scenario in order.
Infrastructure files hide only Agent setup and provider mechanics. Add another
Agent as one new readable case, plus only the infrastructure or provider
protocol it actually needs.

Each Agent receives an isolated home and XDG directories. Configure it through
the same mechanism available to users, with an inert credential and a loopback
base URL. Never redirect DNS, patch the Agent, or reuse developer credentials.

## Run

Build the production assets, then supply the real Agent executable:

```sh
pnpm build
MOBIUS_TEST_OPENCODE_PATH=/absolute/path/to/opencode pnpm test:agent-daemon
```

The Codex case likewise accepts `MOBIUS_TEST_CODEX_PATH` and
`MOBIUS_TEST_CODEX_ACP_PATH`. Without overrides, cases resolve `opencode`,
`codex`, and `codex-acp` from `PATH`. CI installs the repository-tested versions
before running the suite. Missing Agent software is a setup failure, not a
skipped test.
