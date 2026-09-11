# Embedded Mobius Runtime

After this, a Node.js host can run the same local Runtime engine as the Mobius
CLI and connect it directly to Mobius Relay without copying daemon code.

The stable entry is `@moxt-ai/mobius/runtime`. It is part of the existing
`@moxt-ai/mobius` package; there is no additional local-runtime package.

Pair and persist a Runtime without invoking the CLI parser:

```ts
import { pairMobiusRuntime } from "@moxt-ai/mobius/runtime";

const shutdown = new AbortController();
const paired = await pairMobiusRuntime(
  {
    defaultWorkspace: "/srv/moxt/workspace",
    pairingCode: "XXXX-XXXX-XXXX-XXXX-XXXX",
    pairingId: "rpr_...",
    relayOrigin: "https://relay.example.com",
  },
  shutdown.signal,
);
```

The pairing API redeems `POST /v1/runtime-pairings/{pairingId}/redeem`, saves
only the returned Runtime Credential, and prepares the exact
`WSS /v1/runtimes/connect` data-plane endpoint. `resumeMobiusRuntime` reloads a
previously persisted connection by Channel ID.

```ts
import {
  createMobiusRuntimeEngine,
  loadMobiusRuntimeConnection,
} from "@moxt-ai/mobius/runtime";

const shutdown = new AbortController();
const connection = loadMobiusRuntimeConnection(process.env);
const runtime = await createMobiusRuntimeEngine(
  connection,
  shutdown.signal,
  process.env,
);

await runtime.run(shutdown.signal);
```

The environment contract is:

| Variable | Meaning |
| --- | --- |
| `MOBIUS_CHANNEL_ID` | exact paired Runtime channel identifier |
| `MOBIUS_RELAY_URL` | Relay `ws:` or `wss:` endpoint |
| `MOBIUS_RELAY_TOKEN` | exact Runtime Credential |
| `MOBIUS_DEFAULT_WORKSPACE` | optional default local workspace |
| `MOBIUS_STATE_DIRECTORY` | optional local Mobius state directory |
| `MOBIUS_AUDIT_DATABASE` | optional explicit local audit SQLite path |

The factory resolves and creates the real workspace, discovers the local Agent
inventory through the production adapters, constructs the daemon configuration,
and returns a single-use engine. `run(signal)` owns and closes the audit store and
propagates cancellation through Relay, ACP adapters, and Agent processes.

Only a Runtime Credential is accepted for the long-lived Relay connection.
Values shaped as Platform AppCredentials or Conversation credentials are rejected
before Agent discovery or network I/O. The local execution boundary still
normalizes the executable and workspace and enforces local grants immediately
before a side effect. The connector removes the credential from the WebSocket URL
and presents it only as the `Authorization: Bearer` upgrade header. Finite Runtime
requests, including Agent catalog publication, active-turn reconciliation, and
prompt artifact downloads, use the same header and never copy the credential into
their HTTP URLs.

The `mobius pair` and `mobius start` shells now delegate to
`MobiusRuntimeEngine`. Moxt's packaged CLI imports the same `/runtime` entry and
provides a hidden host command for its integration, so both binaries execute one
implementation and connect directly to Mobius Relay. Stopping either host with
SIGINT or SIGTERM aborts the engine and releases its owned resources.
