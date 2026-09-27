# Testing

## Test boundary contract

Use real production components wherever possible. Web / Chat tests run the real
application, router, stores, SDK, Chat, Platform, Runtime relay, production daemon,
transports, and storage. Their one external replacement is a stateful controlled
**Agent harness**, connected through the production adapter. The daemon continues
to own queueing, reconnects, snapshots, history, cancellation, and errors. Do not
substitute a fake daemon, API transport, or Platform response table.

Test Agent compatibility separately in `tests/agent-daemon`: run the **real daemon,
real Agent executable, and production adapter**. Codex, Claude Code, OpenCode, and
Pi require independent coverage because their protocols and adapter behavior can
differ. A fake daemon advertising an Agent, or a controlled ACP process reporting
its name, does not establish compatibility with that Agent.

A stateful model provider may be controlled to choose deterministic outputs while
the real Agent handles requests, tools, persistence, and its native protocol.
Likewise, external identity services may use documented local providers. These
exceptions do not permit faking the owned product layers. Controlled ACP peers are
reserved for explicitly documented protocol faults that a real Agent cannot
produce reliably, not the default execution path for Agent behavior.

## Agent-daemon coverage

For each supported Agent, cover its supported behavior through daemon input and
observable protocol output: session creation and continuation, streaming and tool
results, cancellation and queued work, permissions/interactions, history and file
reads, and relevant reconnection or identity behavior. Unsupported capabilities
must be reported explicitly, not simulated as successful behavior.

Keep Agent-specific setup and assertions in separate Agent files. Share transport,
cleanup, and fixture plumbing when genuinely identical. Tests must use production
adapters; no adapter module replacement, spies, or fabricated Agent responses.

`tests/agent-daemon/README.md` records the actual matrix and prerequisites. Fixture
code alone is not test coverage. Each supported Agent has real tool execution,
continued streamed replies, native session creation, active cancellation, and
queued continuation coverage through production discovery and adapters. Codex also
covers FIFO queue cancellation, execution snapshots, history/files, and native
continuation after process-capacity eviction. Real permissions/interactions,
reconnection, and non-Codex history/file coverage remain gaps. Keep the actual
matrix explicit; controlled protocol scenarios do not establish real compatibility.

## Commands and verification

For routine changes run `pnpm lint`, `pnpm typecheck`, and related integration
cases. `pnpm test:agent-daemon:real` runs real Agent tests. The existing
`pnpm test:agent-daemon:controlled` command runs controlled protocol and daemon
fixtures; passing it is not evidence of real Agent compatibility. `pnpm test`
currently runs controlled Agent/daemon tests, SDK tests, and local Cloudflare
Platform and Standalone Worker integration tests. Real Agent tests are a separate
command. `pnpm build` verifies bundles without deploying them.

Start behavior changes with a failing Given-When-Then scenario through the first
supported product boundary. Enter Worker tests through HTTP, WebSocket, Durable
Object, or storage boundaries. Assert observable behavior, not internal calls.
Use deterministic fake timers for time rules, event-driven waits for progress,
cancellation, finite timeouts, isolated Agent homes/workspaces, and complete cleanup.
Missing required real binaries must fail with an actionable prerequisite error;
do not silently fall back to a controlled Agent or skip compatibility coverage.

Local tests create fresh databases from committed migrations. Old database
contents and old schema versions are outside the repository contract. Consumers
verify Chat integration after updating the Mobius submodule and SDK dependency.

## Avoid duplicate coverage

Keep one controlled ACP scenario for Agent-independent protocol behavior; changing
only an advertised Agent name does not add compatibility coverage. Real Agent
scenarios remain separate because they exercise different executables and adapters.
Use controlled peers for deterministic edge cases, cancellation races, malformed
responses, and resource limits that real Agents cannot reliably produce.

Prefer observable transport behavior over additional successful codec round trips.
Keep rejection tests for malformed or unauthorized input. Daemon liveness scenarios
own readiness and heartbeat exchanges, including reconnect and missing acknowledgements.
CLI help text and diagnostic timing-field round trips are not dedicated test targets.
