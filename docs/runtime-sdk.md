# Embedded Mobius Runtime

After this, a Node.js host can run the same local Runtime engine as the Mobius
CLI and connect it directly to Mobius Relay without copying daemon code.

The stable entry is `@moxt-ai/mobius/runtime`. It is part of the existing
`@moxt-ai/mobius` package; there is no additional local-runtime package.

Pair and persist a Runtime without invoking the CLI parser. The host owns an
explicit installation store: choose a stable reverse-DNS application ID and a
local state root. Mobius keeps that application's connections, audit database,
and Agent adapters beneath its own installation directory; the host explicitly
chooses the default workspace.

```ts
import {
  MobiusRuntimeEngine,
  openRuntimeInstallationStore,
  pairMobiusRuntime,
  resumeMobiusRuntime,
} from "@moxt-ai/mobius/runtime";

const shutdown = new AbortController();
const installation = await openRuntimeInstallationStore(
  {
    applicationId: "com.moxt.cli",
    stateDirectory: "/Users/me/.mobius",
  },
  shutdown.signal,
);
const paired = await pairMobiusRuntime(
  installation,
  {
    defaultWorkspace: "/srv/moxt/workspace",
    pairingCode: "XXXX-XXXX-XXXX-XXXX-XXXX",
    pairingId: "rpr_...",
    relayOrigin: "https://relay.example.com",
  },
  shutdown.signal,
);

// Persist paired.connectionId in Moxt's own settings. It is opaque; do not
// derive it from the Relay channel ID.
await new MobiusRuntimeEngine(paired.config).run(shutdown.signal);
```

On a later process start, reload the opaque local Connection ID from the host
application's own settings:

```ts
const resumed = await resumeMobiusRuntime(installation, savedConnectionId, shutdown.signal);
await new MobiusRuntimeEngine(resumed.config).run(shutdown.signal);
```

The pairing API redeems `POST /v1/runtime-pairings/{pairingId}/redeem`, saves
only the returned Runtime Credential, and prepares the exact
`WSS /v1/runtimes/connect` data-plane endpoint. `resumeMobiusRuntime` reloads a
previously persisted connection by its opaque local Connection ID. Connections
are not named after Relay channel IDs, so one host application cannot discover
or resume another application's local records merely by knowing a channel ID.
The store's `importLegacyConnection` method is available only for an explicitly
selected old `~/.mobius/connections/<channel-id>.json` record; it does not scan,
move, or delete legacy records.

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
| `MOBIUS_STATE_DIRECTORY` | optional local state directory for the direct environment factory; use an installation store for app isolation |
| `MOBIUS_AUDIT_DATABASE` | optional explicit local audit SQLite path |

The factory resolves and creates the real workspace, discovers the local Agent
inventory through the production adapters, constructs the daemon configuration,
and returns a single-use engine. `run(signal)` owns and closes the audit store and
propagates cancellation through Relay, ACP adapters, and Agent processes.

Only a Runtime Credential is accepted for the long-lived Relay connection.
The Runtime validates its issued 43-character base64url credential format
before Agent discovery or network I/O, without interpreting hosting credentials.
The local execution boundary still normalizes and authorizes the executable and
workspace immediately before a side effect. The connector removes the credential from the WebSocket URL
and presents it only as the `Authorization: Bearer` upgrade header. Finite Runtime
requests, including Agent catalog publication, active-turn reconciliation, and
prompt artifact downloads, use the same header and never copy the credential into
their HTTP URLs.

The `mobius pair` and `mobius start` shells now delegate to
`MobiusRuntimeEngine`. Moxt's packaged CLI imports the same `/runtime` entry and
provides a hidden host command for its integration, so both binaries execute one
implementation and connect directly to Mobius Relay. Stopping either host with
SIGINT or SIGTERM aborts the engine and releases its owned resources.
