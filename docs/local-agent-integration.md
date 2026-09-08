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
  agent-specification.ts             Direct and bridged ACP topologies
  agent-discovery-context.ts         Trusted local discovery inputs
  executable-discovery.ts            Local-first path and version verification
  acp-readiness-probe.ts             Bounded ACP initialization probe
  discover-agent.ts                  One specification to one discovery result
  agent-discovery.ts                 Ready/unavailable states and inventory
  discover-local-agents.ts           Public facade and catalog orchestration
```

An Agent specification owns only Agent-specific discovery policy:

- stable ID and label;
- direct ACP or bridged ACP topology;
- executable and local override names;
- fixed launch arguments and environment;
- managed executable validation;
- version probe settings;
- ACP capability and lifecycle conformance.

`DirectAcpAgentDefinition` accepts one executable override and one managed path,
then uses them for both the Agent and ACP process. A direct Agent therefore
cannot accidentally mix identities from two executables.

Managed ACP adapter metadata and installation stay under
`packages/cli/src/agent-installation/`. Adapter installation is an explicit
integration action and remains separate from read-only Agent discovery. Mobius
does not install Agent CLIs.

## Adding an Agent

1. Write a Given-When-Then integration scenario for the first supported
   product boundary.
2. Add `agents/<agent>-agent.ts`. Extend `DirectAcpAgentDefinition` when the
   Agent itself speaks ACP, or `BridgedAcpAgentDefinition` when Mobius launches
   a separate ACP adapter.
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

Discovery is part of the local execution boundary. Remote clients can select a
registered Agent ID and request its integration, but they cannot provide an
executable path, command, argument, environment variable, managed artifact, or
capability claim. The daemon re-runs local discovery for every request and
rejects the integration with `agent_not_installed` until the Agent executable
passes the local version probe. Detected Agent paths and versions are output
metadata for authenticated channel clients; they are never accepted back as
execution authority. Local and managed executables must both be resolved and
verified immediately before use.
