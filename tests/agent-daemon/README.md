# Agent and daemon integration tests

These tests treat an Agent and the production Mobius daemon as one system.
`fake/` drives deterministic daemon, ACP, storage, and failure behavior with one
controllable ACP fixture. `real/` drives compatibility through the production
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
3. the fake provider selects a real Agent tool, the Agent executes it, and the
   result returns to the provider;
4. the tool activity crosses ACP and is visible in persisted server history;
   and
5. the prompt completes with the final provider response in that history.

Do not drive the scenario by calling Agent discovery, `AcpSessionManager`, an
ACP client, or the Agent executable from the test. Those are internal links in
the path being proved.

The fake provider is a permissive executable dependency, not a request mock.
Its job is to let the real Agent work without hosted credentials. It should
implement the smallest valid provider response. The distinctive response that
returns through ACP and server history proves that the Agent connected. Do not
assert the Agent's request path, headers, payload shape, prompt rewriting, or
auxiliary model calls unless Mobius itself depends on that behavior.

Choose a harmless tool from the Agent's advertised tools by loose name and
schema matching. Prefer a shell-like tool running `pwd`, then a read-like tool.
Return the final answer only after a tool-result item appears in the next model
request. This keeps the provider tolerant of Agent-specific tool names and
unrelated model calls while proving the complete tool round trip.

## Layout

```text
tests/agent-daemon/
  README.md
  fake/
    acp-session-features.integration.test.ts
    daemon-connection-liveness.integration.test.ts
    ...
  fixtures/
    fake-acp-agent/
  real/
    claude.integration.test.ts
    codex.integration.test.ts
    copilot.integration.test.ts
    cursor.integration.test.ts
    deepseek.integration.test.ts
    gemini.integration.test.ts
    grok.integration.test.ts
    hermes.integration.test.ts
    opencode.integration.test.ts
    pi.integration.test.ts
    workbuddy.integration.test.ts
  infra/
    journey.ts
    claude.ts
    codex.ts
    copilot.ts
    cursor.ts
    deepseek.ts
    executable.ts
    gemini.ts
    grok.ts
    hermes.ts
    opencode.ts
    pi.ts
    workbuddy.ts
  providers/
    anthropic.ts
    cursor.ts
    gemini.ts
    openai.ts
```

Each file in `fake/` owns a daemon behavior or explicit failure risk. The files
use the same fake ACP executable from `fixtures/`; there is no command-shell
suite or second fake Agent.

Each file in `real/` is the compatibility control surface: it names the real
Agent, provider, and Agent-specific behavior. `infra/journey.ts` keeps the
common production path (pairing, daemon, SDK session, turn, and
persisted-history assertion) identical between cases. Other infrastructure
files hide only Agent setup and provider mechanics. Add another Agent as one
new readable case, plus only the infrastructure or provider protocol it
actually needs.

Each Agent receives an isolated home and XDG directories. Configure it through
the same mechanism available to users, with an inert credential and a loopback
endpoint. Cursor exercises its native Cursor control and AgentService protocols;
the other providers exercise their corresponding LLM protocol. Never redirect
DNS, patch the Agent, or reuse developer credentials.

The Cursor provider records its native request and response messages in an
NDJSON trace and reports its path on failure. Raw capture stays inside each
protocol implementation so diagnostics preserve the actual wire format.

## Run

The public command runs deterministic fake-Agent coverage first and then the
real-Agent compatibility cases. Build the production assets and supply the real
Agent executables before running the whole boundary:

```sh
pnpm build
MOBIUS_TEST_OPENCODE_PATH=/absolute/path/to/opencode pnpm test:agent-daemon
```

The Claude, Codex, GitHub Copilot CLI, Cursor CLI, DeepSeek Harness, Gemini, Grok Build, Hermes, Pi, and WorkBuddy cases likewise accept
`MOBIUS_TEST_CLAUDE_PATH`, `MOBIUS_TEST_CLAUDE_ACP_PATH`,
`MOBIUS_TEST_CODEX_PATH`, `MOBIUS_TEST_CODEX_ACP_PATH`,
`MOBIUS_TEST_COPILOT_PATH`,
`MOBIUS_TEST_CURSOR_LOCAL_PATH`,
`MOBIUS_TEST_DEEPSEEK_HARNESS_PATH`,
`MOBIUS_TEST_GROK_BUILD_PATH`,
`MOBIUS_TEST_HERMES_PATH`,
`MOBIUS_TEST_PI_PATH`, `MOBIUS_TEST_PI_ACP_PATH`, and `MOBIUS_TEST_WORKBUDDY_PATH`, with Gemini using
`MOBIUS_TEST_GEMINI_PATH`. Without overrides, cases resolve their executables
from `PATH`. CI installs the repository-tested versions and runs each Agent as
an independent matrix job. Missing Agent software is a setup failure, not a
skipped test.

CI creates matrix jobs only for Agents affected by the Git diff. Agent-owned
cases, fixtures, and specifications select one Agent; shared provider fixtures
select their protocol group; shared daemon, ACP, SDK, protocol, and server code
select every Agent. Documentation and unrelated application code select none.
Unknown files under this test suite and failures to read the diff select every
Agent so the optimization cannot silently omit coverage.
