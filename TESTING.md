# Testing

## Test boundary contract

Use real production components wherever possible. Web / Chat tests run the real
application, router, stores, SDK, Chat, Platform, Runtime relay, transports, and
storage. Their one product replacement is a stateful **fake daemon**, connected
through the production daemon protocol port. This makes queueing, reconnects,
multiple viewers, history, images, and errors deterministic. Do not substitute a
fake API transport, Platform response table, or fake ACP Agent for this boundary.

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
code alone is not test coverage. The real suite covers Codex and separate Claude Code, OpenCode, and Pi scenarios.
The latter verify tool execution and continued streamed replies through production
discovery and adapters; they do not yet prove every capability listed above. Keep
the actual coverage matrix explicit rather than treating a smoke journey as complete
coverage of history, queueing, cancellation, and interactions.

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
