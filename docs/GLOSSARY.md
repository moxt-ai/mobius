---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Mobius glossary

Mobius connects an application to coding Agents running on users' machines. This
glossary defines the product, identity, and deployment terms used across the SDK,
CLI, Platform, and operational dashboards.

## How the concepts relate

```text
Tenant
  └── App
       └── Project
            ├── Runtime
            │    ├── Agent
            │    └── Session
            └── Runtime

Machine
  └── local daemon
       ├── saved Connection ── authenticates one Runtime
       └── saved Connection ── authenticates another Runtime
```

An App can serve many Projects. A machine can host more than one Runtime, including
Runtimes from different Projects or Apps. A Runtime is created by pairing; it is not
the machine itself and is not created once per Session.

## Product concepts

### Tenant (organization)

The Platform administration boundary that owns Apps and their administrators. A
Tenant is not a Project and does not represent an end user's local machine.

### Platform

The cloud control plane for Tenants, Apps, credentials, Projects, deployment
placement, and policies. Platform administration prepares access to Mobius; Agent
execution still happens through a paired Runtime on a user's machine.

### App

An application or service that integrates Mobius. An App owns credentials and can
provision and access Projects according to those credentials' permissions. Morty is
an example of an App built on Mobius.

### Project

The application-facing collaboration and authorization boundary. A Project groups
the Runtimes and Sessions that an application makes available to its users. Project
placement also determines where its cloud state is hosted.

### Machine

The physical computer, virtual machine, container, or other local environment where
the daemon and coding Agents run. Machine identity and cloud Runtime identity are
different: one machine can host several saved Runtime connections.

### Local daemon

The local Mobius service that manages saved connections, discovers Agents, starts
Agent work, and enforces the local execution boundary. The daemon can keep several
Runtime connections active at the same time.

### Connection

A daemon-side saved pairing record. It contains the information needed to reconnect
one Runtime, including its local workspace and credential. CLI commands address it
by an opaque Connection ID. A Connection ID is local to the installation; it is not
a Runtime ID, Session ID, or Channel ID.

### Pairing

The workflow that authorizes a machine for a Project, creates a Runtime identity,
and saves the corresponding Connection locally. Retrying the same pairing request
can be idempotent, but starting a new pairing creates a new Runtime. Pairing is not
required again merely because an existing Connection reconnects.

### Runtime

A Project-scoped logical endpoint for local Agent execution. A Runtime belongs to
one Project, exposes the Agents and workspace available through one saved Connection,
and carries many Sessions over one daemon-to-Relay connection. It is not a process,
machine, Agent, or individual conversation.

### Agent

A coding Agent available on the Runtime's machine, such as Codex, Claude Code, or
Pi. The Runtime advertises an Agent catalog; each Agent's adapter and capabilities
determine which operations and content types it supports.

### Agent adapter

The local boundary that translates a supported Agent's native interface into Mobius
conversation semantics. ACP Agents use the ACP adapter; other supported Agents need
an adapter that preserves the same user-visible meanings. An adapter does not turn
all Agents into identical products or capabilities.

### ACP

Agent Client Protocol, the protocol used at the local client-to-Agent boundary for
supported Agents. Mobius reuses its conversation semantics but adds remote identity,
routing, observation, and control. The Mobius Relay protocol is not an ACP tunnel.

### Workspace and directory

The local filesystem context made available to Agent work. A Connection has a
default workspace, while Session operations use authorized directory identities
instead of trusting arbitrary remote paths. Additional directories can extend a
Session's authorized context without changing its Runtime identity.

### Session

A Mobius conversation and execution scope on one Runtime. A Session selects an
Agent and workspace context, accepts prompts and control operations, and publishes
shared live events. Multiple clients can observe and interact with the same Session.

### Native Session

A conversation identity owned by the underlying Agent. Mobius can discover, attach,
load, or fork native Sessions when the Agent supports those operations. A native
Session is not the same thing as a Mobius Session, even when Mobius connects the two.

### Prompt, Turn, and command

A prompt is the user's requested input. A Turn is the application-facing unit used
to submit that input to a Session. The daemon may queue the corresponding command
before Agent execution starts. In the current contract, a Turn ID and its daemon
command ID are the same identity within one Runtime and Session; see the
[prompt identity contract](protocol.md#prompt-identity-across-http-and-daemon-apis).

### Interaction

A decision requested while Agent work is in progress, such as a permission request
or supported elicitation. Mobius carries the request and response, while the local
execution boundary remains responsible for authorization and validation.

### Relay

The trusted cloud service that authenticates participants and routes requests,
control operations, and live events between applications and local Runtimes. The
Relay can process Session traffic; Mobius does not claim end-to-end encryption.

### Recording

The optional, best-effort cloud copy of Session events and derived history. Recording
is off by default, can contain prompts and tool content, and never blocks live
delivery. It is not a lossless audit archive and does not keep an offline Runtime
executing.

### History and live events

Live events describe work as the daemon observes it. Native history belongs to the
Agent. Recording is an optional cloud copy. These sources have different availability
and recovery guarantees; reconnecting does not turn any one of them into a guaranteed
complete event log.

## Credentials and identifiers

### AppCredential

A server-side secret issued to an App. Its permissions and optional Project scope
authorize Platform and Project operations. It must not be exposed to a browser or
stored as a Runtime credential.

### Runtime credential

A secret saved with one local Connection and presented by the daemon when that
Runtime connects to the Relay. It proves the Runtime's Project-scoped pairing and
can be revoked independently of other Runtimes on the same machine.

### Session access credential

A limited credential issued for browser or client access to a particular Session.
It carries a Runtime and Session target plus an expiry. It does not authorize the
holder as the daemon or as the App's backend.

### Pairing code and pairing tokens

Temporary secrets used to complete and observe the pairing workflow. They create or
deliver the persistent Runtime credential; they are not used as the Runtime's normal
reconnection credential.

### Runtime ID

The cloud identity created for one pairing. It selects the Runtime's Relay execution
scope and remains distinct from the local Connection ID and physical machine.

### Channel ID

An internal Relay routing identity associated with a pairing. Applications should
use Project, Runtime, and Session identities, while CLI lifecycle commands use the
local Connection ID.

## Cloud deployment labels

These names describe Cloudflare deployment units visible in code, logs, and usage
reports. They are not additional product resources that an SDK user must provision.

### Durable Object

A Cloudflare stateful compute instance selected by a stable name or a unique ID.
Mobius uses different Durable Object classes to isolate Project state, Runtime
connections, browser transports, and Recording state. Splitting work across objects
changes routing and fault isolation; billing still counts aggregate requests,
duration, and storage operations.

### Project Durable Object (`ProjectDO`)

The Project-scoped cloud boundary for Project data and operations. It is keyed by
Project, not by machine or Session.

### Runtime Relay (`RuntimeRelay`)

The Runtime-scoped cloud boundary that owns the daemon connection, routes Runtime
operations, and fans out Session events. One Runtime Relay serves many Sessions for
one Runtime. It is not another local Runtime process.

### WebSocket Transport (`WebSocketTransport`)

The browser-facing transport boundary. It multiplexes authenticated SDK operations
and live subscriptions over a browser WebSocket, manages transport lifetimes, and
keeps browser heartbeat handling separate from Runtime execution.

### Recording Directory and Session Recording

Recording Directory state indexes recorded Sessions for discovery. Session Recording
state stores and projects the recorded events for one Session. Both exist only for
the optional Recording service and are outside the live delivery requirement.
