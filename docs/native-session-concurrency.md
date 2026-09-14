# Native session concurrency

Status: native imports propagate opening failures without a saved-history fallback.
Broader observation and control-transfer behavior is proposed below. Both original-session continuation and
explicit fork remain product features. Mobius does not provide cross-process
live takeover.

After this, a user can attempt to open a saved conversation and see either a ready
conversation or the opening error, then retry after resolving the failure.

## Protocol findings

Reviewed on 2026-09-05 against ACP v1 and the installed Codex ACP 1.8.0 and Claude
ACP 0.73.0 adapters.

- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
  defines `session/load` as restoring context and replaying conversation updates.
  A successful response means the replay has finished. It is not an ownership
  token, an active-turn report, or proof that another process is idle.
- The same specification defines `session/resume` as context restoration without
  history replay. Neither response defines a cross-process handoff, exclusive
  writer lease, event cursor, or atomic history-to-live-stream subscription.
- [Session list](https://agentclientprotocol.com/protocol/v1/session-list)
  provides discovery metadata. `updatedAt` is not a running-state signal.
- [Session delete](https://agentclientprotocol.com/protocol/v1/session-delete)
  explicitly leaves deletion of an active session to the implementation. A
  successful delete need only remove the session from subsequent lists.
- [Session fork](https://agentclientprotocol.com/rfds/session-fork) is an unstable
  capability. It creates a different session ID; support and errors must be
  checked independently of load/resume. It does not define an atomic checkpoint
  of another process's unfinished turn.

The installed Codex adapter restores a thread in its own app-server connection;
its history path also reads the thread and replays it. The installed Claude
adapter restores a query in its own session map and replays stored messages.
These process-local maps do not establish control of a separate terminal process.
See the pinned [Codex source](https://github.com/agentclientprotocol/codex-acp/blob/v1.8.0/src/CodexAcpServer.ts)
and [Claude source](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.73.0/src/acp-agent.ts).

Codex 0.153.4 does enforce exclusive writers: restoring an already-owned thread
returned `already has an active writer` in a real browser reproduction. The ACP
adapter forwards this as a generic internal error, so Mobius must not classify
ownership by matching that text. ACP's lack of a standard ownership response does
not imply that the underlying Agent has no protection.

The [Codex app-server API](https://learn.chatgpt.com/docs/app-server) defines
`thread/read` as reading a stored thread without resuming or subscribing to it.
This succeeded for the same externally owned thread. A reader's `notLoaded`
status describes that connection; it does not prove the original writer is idle.

## Implemented recovery

When an authorized import fails at the ACP execution boundary, Mobius propagates
the original typed opening error. It does not start a temporary history reader or
return a read-only preview. Cancellation and timeout remain distinct failures.
No native writer-conflict classification is inferred from an ACP error message.

The user can retry the normal import path after resolving the failure, such as
closing the session in another application. Only successful restoration opens an
executable conversation with its available history. Fork remains an explicit,
independent operation when supported; a failed import never automatically forks
or terminates another application's writer.

## Proposed behavior

Opening, observing, controlling, and forking are different operations. Keep both
**Continue original session** and **Fork session**. Loading never silently forks;
forking never silently falls back to original-session continuation. The access
state, rather than the user's choice of label, determines whether a mutation is
currently authorized.

| Session known to the local boundary | Opening it | Continuing it | Destructive controls |
| --- | --- | --- | --- |
| Running in this Mobius daemon | Select the existing conversation and observe its live stream; do not call load/resume | Keep the existing turn and its current prompt policy | Stop targets this daemon's turn; fork/delete wait until idle |
| Idle and managed by this Mobius daemon | Select or restore its existing conversation | Reuse its managed execution path | Existing local capability and target authorization applies |
| External, exposed through a cooperative execution authority | Attach an observer to its snapshot and live stream | Acquire or transfer control through that authority, then continue the original native ID; explicit fork remains separate | Controls target the actual executing owner and require its current generation |
| External or ownership cannot be verified | Show available saved history with an explicit snapshot state | Original continuation stays unavailable until verified control can be obtained; explicit fork is independently available when supported | Do not claim that Stop controls the external process; delete requires an adapter contract that safely rejects an active target |
| Agent cannot fork an external session | Show available saved history | Continue the original only through verified control; otherwise offer a new chat | Never silently fall back from fork to prompting the original session |
| Disconnected or ownership lost | Retain readable history and show unavailable execution | Re-establish local ownership before enabling controls | No stale control request is executed |

The web UI keeps the existing sequence: choose a local Agent, then browse that
Agent's sessions. It uses **Open conversation** for a managed or observable session
and **View saved history** when only a snapshot is available. The latter view keeps
original continuation and fork as distinct actions, explaining an unavailable
original-continuation action at that control. Forking is explicit, and its result
has a distinct conversation identity and a visible link to its source.

For a cooperative external session, opening it while a turn is running does not
cancel that turn or restart its execution. The observer sees live output and a
running state. Control transfer is a separate transition. Once the same shared
authority reports idle and grants control, the composer can send a new prompt to
the original native ID. Fork creates a different ID whether the original is idle
or running, subject to the Agent's supported snapshot semantics.

Viewing history must not be presented as live attachment. Refresh is explicit;
it replaces the snapshot without duplicating messages. If the source is changing,
the snapshot may contain only the history exposed by the Agent at that time.
Do not invent a completed-turn marker or claim a consistent checkpoint that the
Agent did not supply.

ACP `session/load` is a lifecycle operation, not a standard read-only history API.
For each supported adapter, verify that history inspection through a temporary
connection does not prompt, cancel, close, or reconfigure the original execution
process. If that cannot be established, only show a previously recorded snapshot
or require an explicit fork before loading history. Killing the inspection
process must not send `session/close` to an externally owned session.

Forking isolates the conversation continuation; it does not isolate the working
directory. Two sessions can still modify the same files. A worktree is a separate
user-visible choice and must not be silently created or implied by session fork.

## Local authority and persistence

Use explicit variants for saved snapshot, observing, controlled idle, controlled
running, and unavailable access. Observing carries the owner and event revision;
controlled states carry the control generation, and only controlled running carries
an active turn identity. Saved snapshots carry no execution authority.
The local daemon determines the variant. A client assertion, a stored mapping,
an old ready event, or an Agent-provided metadata field cannot grant execution
authority. Legacy imports without provenance remain unverified.

Persist whether a native ID was created by Mobius, forked by Mobius, or only
imported for inspection. Persist the source relationship separately from the
continuation's identity. Provenance explains creation; it is not proof that an
arbitrary external program will respect Mobius's ownership.

Serialize Mobius management and prompt operations by the local Agent identity and
native session ID. Recheck the state at execution time. Multiple browser views
share one daemon-owned runtime and turn; opening a view never creates another
writer. Reconnecting reconstructs live state from the owning daemon and recorded
events, rather than using a successful ACP load as evidence of idleness.

Enforce read-only access at prompt, configure, cancel, close, fork, and delete
boundaries, not just by disabling the composer. Keep typed errors for unknown
ownership, busy sessions, ownership loss, and unsupported independent continuation.
Retain cancellation, operation deadlines, canonical workspace authorization,
auditing, and the existing single web confirmation for an authorized deletion.

Do not infer external idleness from process names, installation directories,
quiet files, elapsed time, or the absence of recent list updates. A Mobius-only
lock protects Mobius participants; unrelated CLI processes do not honor it.

## Continuing the original external session

Continuing the original native ID remains supported. For external sessions it
requires a shared execution authority that both the terminal and Mobius use:

1. Attach observers using a revisioned snapshot plus a resumable event stream.
2. Acquire control atomically for the exact Agent instance and native session.
3. Return the active turn, owner generation, and state revision with control.
4. Fence every mutation at the shared execution authority. An old controller's
   commands must be rejected after transfer, including commands already queued.
5. Transfer only after the original controller releases control or a documented,
   explicit takeover completes. Do not kill an unrelated CLI process by guessing
   its PID or treat an idle observation as permission to acquire ownership.
6. Keep an in-flight turn owned by its existing executor while observers attach;
   permission replies and cancellation must reach that same executor.
7. On owner failure or disconnect, retain readable history and withdraw controls.
   Recover ownership through the same authority; do not create a competing writer.

This may be implemented by an Agent's existing shared server, a cooperative
launcher/bridge used by both clients, or a future negotiated ACP extension. It
cannot guarantee takeover of an arbitrary, already-running standalone CLI that
provides no shared control interface. Unverified integrations retain the saved
snapshot, with original continuation unavailable and explicit fork governed by its
own capability.

## Acceptance scenarios

- Given a Mobius turn is running, when another browser opens that session, then
  both views receive that same turn's output and opening the view does not
  interrupt, replay, or create another prompt.
- Given an external session is still producing output, when its saved history is
  viewed, then its original process continues and Mobius exposes no original-turn
  controls or original-session prompt path.
- Given an external session has a saved history prefix, when a user creates an
  independent continuation, then the Agent returns a distinct native ID and new
  messages appear only in that continuation.
- Given an Agent cannot fork, when a remote client attempts independent
  continuation, then the local boundary returns a typed unsupported result and
  sends no fallback prompt to the original session.
- Given only an unverified legacy import exists, when its composer or a crafted
  remote request attempts to continue it, then the local boundary rejects it
  until an allowed continuation path is chosen.
- Given state changes after listing, when a management action reaches the local
  boundary, then its current ownership and target are revalidated before any
  effect; cancellation or timeout releases the owned resources.
- Given an adapter supports cooperative transfer, when controller generation
  changes, then old-controller mutations are fenced while observers continue to
  receive ordered events from the original execution.

Use real entrypoints with a stateful external Agent port for deterministic
concurrency and failure cases. Exercise real supported Agents separately, including
an actual concurrent terminal run; stored files alone do not prove handoff.
