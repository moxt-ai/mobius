# Local Agent Integration

The local Agent catalog is organized so that Agent-specific policy is separate
from the generic discovery pipeline. Generic discovery code must not branch on
an Agent ID.

## Module boundaries

```text
packages/cli/src/agent-catalog/
  agents/
    <agent>-agent.ts                  Agent identity and ACP contract
    supported-agent-specifications.ts  Discovery registry
  agent-specification.ts             Direct, bridged, and in-process topologies
  agent-discovery-context.ts         Trusted local discovery inputs
  executable-discovery.ts            Local-first path and version verification
  acp-readiness-probe.ts             Bounded ACP initialization probe
  discover-agent.ts                  One specification to one discovery result
  agent-discovery.ts                 Ready/unavailable states and inventory
  local-agent.ts                     Ready-Agent variants per topology
  discover-local-agents.ts           Public facade and catalog orchestration

packages/cli/src/acp/
  in-process/acp-endpoint.ts         In-process ACP endpoint port
  <vendor>/                          One in-process Agent per vendor protocol
```

An Agent specification owns only Agent-specific discovery policy:

- stable ID and label;
- direct, bridged, or in-process ACP topology;
- executable and local override names;
- fixed launch arguments and environment;
- managed executable validation;
- version probe settings and any product-specific output normalization;
- ACP capability and lifecycle conformance;
- for an in-process Agent, the endpoint factory.

## Topologies

`DirectAcpAgentDefinition` accepts one executable override and one managed path,
then uses them for both the Agent and ACP process. A direct Agent therefore
cannot accidentally mix identities from two executables.

`BridgedAcpAgentDefinition` tracks two executables: Mobius spawns a pinned ACP
adapter package and hands it the vendor binary through an environment variable.

`InProcessAcpAgentDefinition` covers a vendor CLI that does not speak ACP at all.
Mobius hosts the ACP Agent inside the daemon and drives the vendor's own protocol
over a child process it owns. There is no adapter to install or version-probe, so
the Agent executable serves as both identities, and `adapterVersion` is
`in-process`.

The in-process Agent itself lives under `packages/cli/src/acp/<vendor>/` and
implements `InProcessAcpEndpoint`:

```ts
type AcpEndpointTermination =
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: AcpExecutionError };

interface InProcessAcpEndpoint {
    readonly terminated: Promise<AcpEndpointTermination>;
    readonly app: () => AgentApp;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly close: () => Promise<void>;
}
```

The daemon connects its normal ACP client to `app()` in memory, so no other
module can tell an in-process Agent from an adapter process. The endpoint owns
every resource it starts and releases them in `close()` on success, failure, and
cancellation alike, including the vendor process tree. Because the endpoint is
reached only through the specification's `createEndpoint` factory, the generic
discovery, probe, and session modules never name a vendor.

`terminated` resolves exactly once and never rejects. Backend exit, loss of its
response stream, protocol failure, and handler failure report `failed`; explicit
close reports `closed`. The first terminal outcome remains authoritative during
cleanup. Both readiness probes and Session operations observe this outcome,
including while a Turn waits after its initial acknowledgement. The endpoint
must also settle its own pending RPCs and Turn completions, preserve cancellation,
and make repeated `close()` calls share the same process-tree cleanup. A healthy
long-running Turn has no arbitrary total execution deadline.

Managed ACP adapter metadata and installation stay under
`packages/cli/src/agent-installation/`. After a paired daemon's first Relay
connection, Mobius automatically provisions only the pinned adapter for locally
detected Agents whose integration is incomplete. The Web `Check again` action
re-runs discovery for supported Agents and automatically provisions integrations
for those it finds. It remains separate from read-only Agent discovery, and
Mobius does not install Agent CLIs.

## Adding an Agent

1. Write a Given-When-Then integration scenario for the first supported
   product boundary.
2. Add `agents/<agent>-agent.ts`. Extend `DirectAcpAgentDefinition` when the
   Agent itself speaks ACP, `BridgedAcpAgentDefinition` when Mobius launches a
   separate ACP adapter, or `InProcessAcpAgentDefinition` when the Agent speaks
   only its own protocol.
3. Keep every executable path, argument, environment variable, and capability
   decision in that specification. Do not add Agent-ID branches to the generic
   discovery modules.
4. Register the specification once in
   `agents/supported-agent-specifications.ts`.
5. For a bridged Agent, add the pinned ACP adapter package contract. Do not add
   an Agent installer; users install and manage the Agent CLI themselves.
6. Cover local-first selection, managed fallback, version validation, ACP
   readiness, cancellation, cleanup, authentication, and the supported session
   lifecycle as applicable. Run the real harness conformance path before
   advertising it as ready.

## Adding an in-process Agent

An in-process Agent adds one step to the list above, because Mobius owns the ACP
conformance that an adapter would otherwise provide.

1. Add `packages/cli/src/acp/<vendor>/` implementing `InProcessAcpEndpoint`:
   translate the vendor protocol to ACP, and own the vendor process tree.
2. Point the specification's `createEndpoint` at it. That factory is the only
   place the vendor is named.

Declare only the capabilities the endpoint actually serves. The daemon re-gates
every request on the capability record, so an optimistic bit becomes an
unsupported ACP call at the far end rather than a degraded experience. Leaving a
capability undeclared is supported: the existing degradation paths cover it.

Let the vendor's own configuration decide vendor policy. An in-process Agent
should not send a sandbox, approval policy, or model that the user did not ask
for, because the vendor CLI already reads its own configuration.

Report failures through the typed ACP error contract in
`packages/cli/src/acp/acp-error.ts`. Endpoints depend on that module rather than
on the session manager, so an endpoint never imports the code that drives it.

Discovery is part of the local execution boundary. Automatic setup reads only
the daemon's locally produced detected-Agent catalog; remote clients can request
a recheck only for registered Agent IDs already published by the daemon. Neither
path can provide an executable path, command, argument, environment variable,
managed artifact, or capability claim. The daemon re-runs local discovery for
every automatic setup and recheck, and rejects the integration with
`agent_not_installed` until the Agent executable passes the local version probe.
Detected Agent paths and versions are output metadata for authenticated channel
clients; they are never accepted back as execution authority. Local and managed
executables must both be resolved and verified immediately before use.
