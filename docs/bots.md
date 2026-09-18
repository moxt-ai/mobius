# Bots and external connectors

Mobius Bot is a stable, project-scoped identity above local Agent execution.
A Bot can exist before a machine is available, retain immutable profile and
behavior history, and own durable conversations and independently revocable
external connections. Runtime, Agent, workspace, Session, and connection IDs
remain execution or transport details; none of them becomes the Bot identity.

This implementation is provider-neutral. A connector owns provider
installation, credentials, webhook verification, account and destination
mapping, rendering, rate limits, and provider delivery. Mobius stores only its
own opaque `connectionId` and `deliveryTargetId` values. Provider credentials
and destinations never enter the Bot, local Agent, daemon, Relay command,
conversation event, or Mobius database.

## Identity and authorization

### Project discovery

`CloudflareBotApi` authorizes each request against its Project:

- `GET /mobius/api/v1/projects` lists Projects from completed pairings.
- `GET /mobius/api/v1/projects/:projectId/bots` lists Bots only when that project
  is authorized for the caller.
- `GET /mobius/api/v1/projects/:projectId/status` resolves the same authorized
  project and returns `connected` or `offline` from the Runtime's live connection
  state. Completing a pairing alone does not imply that the Runtime is online.

Standalone accepts these reads without a login token. Authenticated hosts enforce
their own Project authorization. Client-supplied organization identifiers never
determine access.
Listing does not grant mutation rights. An authenticated read requires
`bot:read`; creating a Bot requires `bot:profile:write` at
`POST /mobius/api/v1/projects/:projectId/bots`. Either permission may come from
an accountless owner or a least-privilege Project application or exchanged
external credential.

Callers with `bot:read` can read
`GET /mobius/api/v1/projects/:projectId/bots/:botId/setup` to inspect lifecycle and
behavior revisions plus the latest execution-binding state and configuration.
Consumers use those revisions with the existing behavior-revision and
execution-binding endpoints. Creating a binding activates it immediately after
the Relay verifies that the selected Runtime currently advertises the Agent and
required capabilities. Project bot lists include `setupStatus` so clients can
distinguish initial setup from an active or unavailable target.

### Bot operation trust planes

Four trusted inputs meet at separate authorization boundaries:

| Trust plane | Authentication | Authority |
| --- | --- | --- |
| Project access | Accountless, exchanged external, application, or browser credential normalized to `ProjectAccessContext` | Use only the Project permissions held by that access context |
| Connector | Credential normalized to `BotConnectionAccessContext` | Use only the scopes and Bot assigned to one connection |
| Runtime | Daemon credential normalized to `RuntimeAccessContext` with the active lease/fence | Receive pinned work for that Runtime |
| Bot execution | Runtime access plus a matching `ExecutionPermit` | Invoke allowed outbound actions for one active execution |

An external `actorRef` is audit context, not an authorization claim. A
connector cannot select or change `agentId`, `runtimeId`, `workspaceRef`, a
command, executable path, callback URL, provider destination, or local
permission decision. Requests containing such fields fail schema validation
before any execution target is resolved.

`BotExecutionCapability` is opaque, server-backed, scoped to one active
execution, and immediately invalid once that execution reaches a terminal
state. It pins the Bot, conversation, turn, behavior revision, binding revision,
Runtime, allowed targets, operation, and use limit. The Runtime credential
proves which daemon is calling; the execution capability proves which Bot
execution is acting.

`executionDeadlineAt` is the dispatch and start-admission cutoff. The daemon
rejects a command that has not started by that time, but an admitted Session
Turn has no total wall-clock execution deadline. It continues until the Agent
finishes, the user cancels it, or the execution fails through another lifecycle
boundary.

Project applications and OIDC exchange are documented in [Project
authentication and credential operations](project-authentication.md). Project
credentials never authenticate on Connector or execution-action routes.

## Lifecycle and revision pinning

A Bot starts as a draft. Profile revisions change presentation without widening
execution authority. Behavior revisions are immutable and become active with a
compatible binding. One Bot has one active behavior and one active binding,
while an already-created conversation remains pinned to the exact behavior and
binding revisions selected at creation.

The main lifecycle values are represented by concrete readonly classes:

- Bot: `DraftBot`, `ActiveBot`, `SuspendedBot`, and `ArchivedBot`.
- Behavior: `ProposedBotBehavior`, `ActiveBotBehavior`, and `RetiredBotBehavior`.
- Binding: `ActiveBotExecutionBinding`, `UnavailableBotExecutionBinding`, and
  `RevokedBotExecutionBinding`.
- Conversation: `ProvisioningBotConversation`, `ActiveBotConversation`, and
  `ClosedBotConversation`.
- Connection: `ActiveBotConnection` and `RevokedBotConnection`.
- Outbound delivery: `AcceptedOutboundMessage`, `QueuedOutboundMessage`,
  `ClaimedOutboundMessage`, `DeliveredOutboundMessage`,
  `RetryableFailedOutboundMessage`, and `TerminalFailedOutboundMessage`.

Suspending a Bot rejects new turns and new outbound actions. Archiving is
terminal. A behavior proposal does not replace the current active behavior
until its binding is created.

## Local execution authority

An execution-binding request is untrusted input even when it comes from an
owner-facing service. Creating the binding does not send an approval request to
the machine and does not create a daemon-local grant. For every command, the
local daemon resolves the advertised Agent again, revalidates the adapter and
Agent executables, resolves the selected directory inside the paired Runtime
root, checks required capabilities, and only then starts the Agent. Remote state
cannot bypass those execution-boundary checks.

Every execution binding also freezes a required `executionConfiguration`:

```json
{
  "model": {
    "booleanValue": false,
    "configId": "model",
    "value": "gpt-5.6",
    "valueType": "select"
  },
  "permissionMode": "workspace-write",
  "reasoningEffort": {
    "booleanValue": false,
    "configId": "reasoning_effort",
    "value": "high",
    "valueType": "select"
  }
}
```

Platform applications such as Moxt obtain the authoritative choices with
`client.runtimes.discoverAgentSettings(runtimeId, { agentId, directoryId,
additionalDirectoryIds: [] }, signal)`. They must submit one discovered model,
one discovered reasoning-effort value, and the discovered permission mode in
`MobiusBotOwnerClient.createBinding`. The HTTP endpoint rejects a missing or
malformed configuration. Binding directory and setup responses return the
frozen value so a tenant can render exactly what will execute.

The daemon receives the same pinned value with every Bot prompt, applies
permissions before process launch, and configures model then reasoning effort
before optional behavior settings. A stale or unsupported selection fails
locally with a typed configuration error. Behavior
`agentConfiguration` remains available for additional Agent options, but it
cannot override the required model or reasoning configuration IDs.

Changing the Agent, workspace selection, configuration, behavior, binding, or
delivery policy is done through the owner-facing binding flow and becomes active
immediately for future conversations. Existing conversations remain pinned to
their recorded behavior and binding revisions. Agent-originated permission or
elicitation requests can still be answered through the ordinary conversation
interaction channel; there is no CLI or machine-local binding approval step.

Several Bots can share one Runtime, Agent executable, or workspace while keeping
separate Bot identities, execution capabilities, conversations, and
delivery targets. This identity isolation is not operating-system isolation.
Use separate workspaces plus an enforced sandbox, container, virtual machine,
or operating-system principal when process and filesystem isolation is needed.

One Project may also have several independently paired Runtimes. Different Bots
can bind to different Runtimes, but each Bot still has exactly one active
execution binding and each conversation remains pinned to its recorded Runtime,
behavior revision, and binding revision. Revoking
one Runtime changes only bindings that name that Runtime to `unavailable`, closes
that daemon connection, and rejects new turns on its existing conversations with
`binding_incompatible`. It does not route work to another Runtime;
Bots bound to other Runtimes remain executable. See [Project Runtime
pairing](runtime-pairing.md).

## Durable inbound and outbound work

Creating a Bot conversation pins the current active behavior and binding.
Provisioning is an idempotent saga between D1 and the Session Durable Object: D1
records a provisioning conversation, the Session runtime installs
`bot_session_context`, and D1 activates that same conversation. Reconciliation
completes interrupted provisioning without creating another Session.

Inbound messages are keyed by `connectionId` and `clientMessageId`. Exact
replays return the original turn; a changed request under the same key returns
`idempotency_conflict`. The Session runtime accepts the turn before dispatch, so
a temporarily offline active Runtime can execute the same pinned work once it
reconnects. Runtime lease fencing prevents two daemon owners from committing
the same output.

A temporary disconnect preserves accepted pinned work for reconnection. Runtime
revocation is terminal: new work for that binding reports explicit
unavailability and is never treated as a failover opportunity.

Outbound requests are keyed by `executionId` and `idempotencyKey`. The Session
runtime first records `AcceptedOutboundMessage`, then idempotently forwards the
same `outboundMessageId` to the connection's `BotConnectionActor`. Its alarm
reconciles interrupted forwarding. The actor owns an ordered cursor stream,
claims each message for a bounded interval, and redelivers an unacknowledged
claim. Connector delivery is therefore at least once; connectors must use the
Mobius IDs and provider-supported idempotency when a provider result is
ambiguous. Pending outbound work survives Bot execution completion and expires
after its bounded retention period.

A required completion policy creates one deterministic outbound message when a
turn completes, even if the Agent never invokes the CLI.

## HTTP API

All routes below are beneath the configured Mobius API prefix, normally
`/mobius/api`. Owner routes require an owner application credential. Every Bot
and Conversation route is scoped beneath the Project that owns it; callers pass
`projectId` and the relay resolves the Bot's shard directly instead of
searching every shard.

Owner control plane:

```text
POST /v1/projects/{projectId}/bots
GET  /v1/projects/{projectId}/bots/{botId}
POST /v1/projects/{projectId}/bots/{botId}/profile-revisions
POST /v1/projects/{projectId}/bots/{botId}/behavior-revisions
POST /v1/projects/{projectId}/bots/{botId}/execution-bindings
POST /v1/projects/{projectId}/bots/{botId}/connection-grants
POST /v1/projects/{projectId}/bots/{botId}/delivery-targets/{deliveryTargetId}/approve
POST /v1/projects/{projectId}/bots/{botId}/suspend
POST /v1/projects/{projectId}/bots/{botId}/archive
```

Connection establishment and management:

```text
POST /v1/bot-connection-grants/redeem
POST /v1/bot-connections/{connectionId}/credentials/rotate
POST /v1/bot-connections/{connectionId}/revoke
POST /v1/bot-connections/{connectionId}/delivery-targets
POST /v1/bot-connections/{connectionId}/delivery-targets/{deliveryTargetId}/disable
```

Owner Conversation data plane:

```text
POST /v1/projects/{projectId}/conversations
GET  /v1/projects/{projectId}/conversations/{conversationId}
POST /v1/projects/{projectId}/conversations/{conversationId}/turns
PUT  /v1/projects/{projectId}/conversations/{conversationId}/turns/{turnId}/disposition
GET  /v1/projects/{projectId}/bots/{botId}/conversations/{conversationId}/messages?cursor={cursor}&limit={limit}
GET  /v1/projects/{projectId}/bots/{botId}/conversations/{conversationId}/events?after={cursor}&wait={milliseconds}
GET  /v1/projects/{projectId}/bots/{botId}/conversations/{conversationId}/attempts/{attemptId}/tool-calls/{toolCallId}
```

The default Turn disposition is `reject`. An owner can submit `queue` or
`steer` with a `targetTurnId`, or atomically promote a queued Turn to `steer`
while its target is still active. The Runtime receives the corresponding
targeted command and the local Agent remains the authority for whether native
steering is supported.

`messages` serializes the canonical Session `readMessages` snapshot and adds
only Bot-facing Turn, execution, and behavior identifiers. Mobius does not keep
a second Bot message projection. `nextCursor` pages older messages, while the
opaque `tailEventCursor` identifies the event position represented by the
snapshot. Complete Tool detail is resolved through Mobius, including archived
detail, without exposing Session identifiers or archive storage keys.

`events` accepts an optional 1-10,000 millisecond `wait`. This is a bounded
long-poll over the same durable opaque cursor, not a second streaming source of
truth. If a Relay request or deployment is interrupted, the caller retries the
same cursor and receives every subsequently committed event.

Inbound connector data plane:

```text
POST /v1/projects/{projectId}/bots/{botId}/conversations
POST /v1/projects/{projectId}/bots/{botId}/conversations/{conversationId}/messages
GET  /v1/projects/{projectId}/bots/{botId}/conversations/{conversationId}/events?after={cursor}&wait={milliseconds}
POST /v1/projects/{projectId}/bots/{botId}/turns/{turnId}/cancel
```

`events` is the sanitized live transport for a connector's active Turn. An event
cursor that predates the retained active range returns `cursor_expired` rather
than replaying raw message deltas. Authoritative `messages` and Tool detail are
restricted to owner credentials even though the shared route remains present.

The initial connector scopes are `inbound-conversation:create`,
`inbound-message:create`, `conversation-events:read`, `turn:cancel`,
`outbound-message:read`, and `outbound-message:ack`. Creating outbound messages
is deliberately not a connector scope.

Bot execution action plane:

```text
POST /v1/bot-executions/{executionId}/reply-messages
POST /v1/bot-executions/{executionId}/delivery-targets/{deliveryTargetId}/messages
```

These endpoints require both the Runtime bearer credential and
`X-Mobius-Bot-Execution-Capability`. They return `202 Accepted` after durable
acceptance; physical provider delivery may happen later.

Connector outbound delivery plane:

```text
GET  /v1/bot-connections/{connectionId}/outbound-events?after={cursor}&limit={limit}
POST /v1/bot-connections/{connectionId}/outbound-messages/{outboundMessageId}/delivered
POST /v1/bot-connections/{connectionId}/outbound-messages/{outboundMessageId}/retryable-failure
POST /v1/bot-connections/{connectionId}/outbound-messages/{outboundMessageId}/terminal-failure
```

Credential rotation returns a new secret once and keeps the previous credential
valid only through the reported overlap deadline. Revoking one connection stops
its send, read, acknowledgement, and target access without affecting another
connection or the Bot identity.

## TypeScript connector client

`@moxt-ai/mobius-sdk` exports the provider-neutral connector client. Redeem a
short-lived, single-use owner-created grant and persist the returned credential
in the connector's secret store:

```ts
import {
  createMobiusBotConnectorClient,
  redeemMobiusBotConnectionGrant,
  StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

const redeemed = await redeemMobiusBotConnectionGrant(
  { endpoint: "https://mobius.example.com" },
  {
    audience: "connector-production",
    connectorPrincipalId: "connector-installation-42",
    grantId,
    grantSecret,
  },
  signal,
);

const connector = createMobiusBotConnectorClient({
  connectionId: redeemed.connectionId,
  credentialProvider: new StaticMobiusCredentialProvider(redeemed.credential),
  endpoint: "https://mobius.example.com",
  projectId: redeemed.projectId,
});

const target = await connector.deliveryTargets.create(
  { alias: "support-inbox" },
  signal,
);
```

Store the real provider destination under `target.deliveryTargetId` outside
Mobius. After the owner approves that target, create a connected conversation
and submit an idempotent inbound message:

```ts
const conversation = await connector.conversations.create(
  redeemed.botId,
  {
    clientConversationKey: "provider-thread-42",
    replyDeliveryTargetId: target.deliveryTargetId,
    title: "Support request",
  },
  signal,
);

const accepted = await connector.conversations.submitMessage(
  redeemed.botId,
  conversation.conversationId,
  {
    actorRef: "provider-user-opaque-reference",
    clientMessageId: "provider-event-1007",
    resourceRefs: [],
    text: "Please investigate this request.",
  },
  signal,
);

const events = await connector.conversations.readEvents(
  redeemed.botId,
  conversation.conversationId,
  accepted.eventCursor,
  signal,
);
```

Resume connector delivery from its last committed numeric cursor. A returned
event carries a `claimId`; acknowledge only after recording the provider result:

```ts
const page = await connector.outboundMessages.read(lastCursor, 100, signal);

for (const event of page.events) {
  await deliverThroughProvider(event.deliveryTargetId, event.text, event.outboundMessageId);
  await connector.outboundMessages.delivered(event.outboundMessageId, event.claimId, signal);
}

lastCursor = page.cursor;
```

Use `retryableFailure` only for an explicitly retryable provider outcome and
`terminalFailure` for a definitive rejection. Preserve the old credential only
until `overlapEndsAt` after `connector.connection.rotateCredential(signal)`.

## Local Bot outbound CLI

During an active Bot execution, the daemon supplies an authenticated local IPC
context to the Agent process. The Agent can submit a provider-neutral message:

```sh
mobius bot message send --target current --text "The task is complete."
mobius bot message send --target support-inbox --text "An operator should review this result."
```

`current` resolves the connected conversation's registered reply target; an
alias resolves only within the execution's approved target set. The command is
unavailable outside an active execution and never accepts a Bot ID, provider
credential, provider destination, Runtime, executable, or workspace override.

## Stable error codes

Boundary failures use sanitized machine-readable codes, including
`bot_not_found`, `bot_not_active`, `bot_suspended`, `behavior_not_active`,
`binding_not_active`, `binding_incompatible`, `connection_not_found`,
`connection_revoked`, `credential_invalid`, `credential_revoked`,
`scope_denied`, `conversation_access_denied`, `execution_context_required`,
`execution_capability_invalid`, `execution_capability_expired`,
`delivery_target_not_allowed`, `delivery_target_unavailable`,
`revision_conflict`, `idempotency_conflict`, `queue_full`, `turn_expired`, and
`runtime_unavailable`. Cancellation, timeout, retryable unavailability,
ambiguous provider delivery, and terminal delivery failure remain distinct.

Existing direct-Agent Sessions keep their current path and are not assigned a
synthetic Bot identity. Bot conversations use a one-to-one
`bot_session_context` extension and reuse the existing Session, Turn, Attempt,
Event, Interaction, and Artifact infrastructure.
