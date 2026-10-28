---
metadata:
  change-policy: >-
    Changes require a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

# Daemon protocol

Mobius lets remote clients use a local Agent and observe the same conversation.
The daemon acts as an ACP client at the local Agent boundary and exposes that
conversation through the relay. Its public protocol reuses ACP conversation
semantics, with additions for remote observation and control; it is not an ACP
JSON-RPC endpoint or a transparent tunnel.

## Relationship to ACP

Use the official [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
and [prompt-turn specification](https://agentclientprotocol.com/protocol/v1/prompt-turn)
as the reference for the current Agent boundary. Agent capabilities determine which
operations and content types are available. An adapter for a non-ACP executable
must preserve those meanings rather than invent a second conversation model.

Mobius's `session.event.v2` names a version of the Mobius event representation;
it does not mean ACP protocol v2. Adopting another ACP version requires an explicit
adapter and compatibility decision.

The following sections explain the overlap and additions. Exact message fields,
validation and unrelated machine-management operations belong in executable schemas
and handlers, not a second inventory here.

## Prompts, execution and interaction

ACP defines sending a prompt, receiving incremental updates, requesting permission
and cancelling execution. Mobius keeps those meanings while separating a remote
prompt's submission from its execution and completion. A queued prompt has not
started an Agent turn. Queue, reject and supported steering behavior are daemon
admission decisions, not guarantees made by ACP's ordinary prompt request.

Queued-submission HTTP replies are advisory. The `session.queue.changed`
notification is scoped to a Session, carries no command identifier, and can also
occur when another queued Turn finishes. The relay can therefore return before
the submitted command has actually entered the queue. A returned Turn identifier
associates the reply with the request; it does not make the queue notification a
confirmation for that command. Where the reply includes a queued state, that state
has the same limitation.

Clients must use the command's own lifecycle events to determine whether it started,
failed or completed, and the available current-turn recovery view to inspect queued
work. A successful submission reply must not override a later command-specific
failure or be treated as proof of execution or durable queue admission. Missing
lifecycle evidence leaves the outcome unknown; live delivery and recovery remain
subject to the limitations below.

Clients observing one session must see prompts submitted by other clients as well
as Agent output. Prompt lifecycle and queue changes therefore accompany ACP updates
in the shared event stream. A command reply alone is insufficient to synchronize
observers. Cancelling work is a request; completion must reflect the Agent's settled
outcome, and updates already in flight can still arrive.

ACP [permission requests](https://agentclientprotocol.com/protocol/v1/prompt-turn)
remain decisions at the local execution boundary. Mobius relays the pending
interaction and the user's response; receiving a response from a remote client does
not bypass local validation or authorization. Supported elicitation follows the
same principle. Session configuration retains the Agent's advertised options and
capabilities; the remote client must not assume all Agents support the same settings.

## Incremental output and current-turn recovery

ACP `session/update` supplies message chunks, tool-call changes and other session
updates. Mobius carries that content model in a versioned event envelope and adds
execution lifecycle information needed by remote clients. Tool changes remain
updates to the same tool call; text chunks remain incremental content. Normal live
output must not repeatedly copy the entire accumulated turn.

Event identity and ordering allow a client to combine available history with live
updates without duplicating content. They do not acknowledge delivery or guarantee
that every event reached every observer. Multiple observers may watch the same
session; the daemon publishes independently of whether a browser is watching.

A returning client needs the available current execution view as well as saved
history, because an unfinished turn may not yet exist in native history. That view
must distinguish queued work, running work and pending interactions. Rejoining must
not resubmit a prompt or mistake history replay for new execution.

Live delivery has no durable delivery queue, acknowledgement or retry guarantee.
Daemon restart interrupts in-memory work. Durable, bounded execution receipts
distinguish commands interrupted by a restart from commands that completed and
prevent replay of commands that already started. Commands that never started may
be resubmitted. Restart outcomes use the existing prompt failure events with a
stable restart reason and remain available after reconnecting. The daemon does
not decide whether to continue interrupted work; applications apply their own
policy and submit a new command to continue the native conversation.

Optional Recording is best effort and cannot block broadcasting or promise
reconstruction of missing output. History availability and execution completion
are separate facts.

## Existing sessions and history

ACP [session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
defines creating and loading conversations. In ACP v1, supported `session/load`
replays the conversation through updates; it is not a source-history pagination
contract. Message IDs alone do not make full replay a bounded page read.

Mobius exposes native-session discovery, attachment and supported forking so users
can continue conversations owned by their Agent. Capabilities and native identity
must remain authoritative: an unsupported operation must not be presented as working
merely because another Agent supports it.

History browsing is separate from preparing an Agent to continue execution. Clients
can request a recent page and older pages using opaque cursors. A page interface
does not establish that the underlying Agent or adapter reads only that page;
full-replay cost and unavailable older history must not be hidden by slicing a
snapshot. Live and historical events share the content model, but reading history
must not start a new turn.

## Content and media

Reuse ACP's [content model](https://agentclientprotocol.com/protocol/v1/content)
for text, media and resources, including content inside tool results. Mobius adds
external-content references so encoded media need not travel repeatedly in live
updates and history pages. Clients retrieve the referenced bytes from the connected
machine through authorized file access. These references are Mobius representations,
not standard ACP content variants.

Content identity or a hash permits reuse, not access. Unavailable media must be
visible without blocking text or execution. Ordinary text resembling base64 remains
text. The image-delivery constraints in [CONTRIBUTING.md](CONTRIBUTING.md#image-delivery-constraints)
also apply when images originate inside ACP tool content.

## Backward compatibility

Mobius protocol releases must support rolling upgrades in which deployed services,
local Runtimes, SDK clients, and persisted messages temporarily use adjacent
versions. ACP negotiation at the Agent boundary does not negotiate the separate
Mobius daemon-to-relay contract.

Compatibility is mandatory unless the human user or maintainer explicitly requires
the specific breaking change. A new protocol version or negotiated capability does
not authorize removal of the existing contract. AI agents must not infer permission
to retire an older peer from a refactoring task or a version bump. Follow
[AGENTS.md](AGENTS.md) and the mandatory [code review rules](CODE_REVIEW.md).

### Compatibility rules

- New receivers validate every field they understand and ignore unrecognized
  fields. Before adding a field, verify that existing receivers also accept it;
  a strict released decoder may reject an otherwise additive change.
- A receiver must continue to accept an older representation that omits a newly
  introduced field. The new field must have an explicit fallback until all
  supported senders provide it.
- Adding a message kind is compatible on long-lived transports. A receiver logs a
  bounded warning and skips an unrecognized kind without closing the connection.
  Skipping an unknown operation is not successful execution: a sender must retain
  the old supported behavior until it establishes support for the new operation.
- A recognized message kind with an invalid known field remains a protocol error.
  Compatibility must not weaken validation of supported representations.
- Removing or changing the meaning, type, or validation of an existing field or
  message kind requires a new versioned representation or negotiated capability.
- A sender must not require an unnegotiated new response from an older peer.

### Delivery requirements

Every protocol change must include a contract scenario for mixed-version behavior.
At minimum, additive fields and message kinds must prove that an older peer can
continue using the connection, while a newer receiver must prove that the previous
representation still receives its documented fallback.

When a change cannot satisfy these rules, introduce a versioned message or an
explicitly negotiated capability and deploy receiver support before enabling the
new sender behavior.
