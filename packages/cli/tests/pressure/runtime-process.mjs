import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [state, channelId, relay, control, sourceRoot] = process.argv.slice(2);
const { AcpAgentDefinition } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/src/engine/acp/agent/agent-definition.ts"))
);
const { createRuntimeConfig, MobiusRuntimeEngine, RuntimeLocalContext } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/src/engine/runtime/engine.ts"))
);
const { ControlledAcpConnection } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/tests/support/agents/controlled-acp-connection.ts"))
);
const agent = new AcpAgentDefinition(
    "pressure-agent",
    "Pressure Agent",
    process.execPath,
    (options) =>
        new ControlledAcpConnection(
            {
                id: "pressure-agent",
                adapterPath: process.execPath,
                arguments: [new URL("./output-peer.mjs", import.meta.url).pathname],
                environment: options.environment,
            },
            options,
        ),
    { MOBIUS_TEST_OUTPUT_CONTROL_PATH: control },
    "1.0.0",
    undefined,
    undefined,
    "1.0.0",
);
const config = createRuntimeConfig(
    { channelId, defaultWorkspace: join(state, "workspace"), relayUrl: new URL(relay) },
    [agent],
    new RuntimeLocalContext(state, { PATH: process.env.PATH, HOME: join(state, "home") }),
);
const cancellation = new AbortController();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
process.on("message", (message) => {
    if (message === "stop") {
        cancellation.abort();
    }
});
process.on("disconnect", () => cancellation.abort());
try {
    await new MobiusRuntimeEngine(config, {
        onConnectionStatus: (status) => process.send?.({ kind: "connection", status }),
    }).run(cancellation.signal);
} finally {
    process.send?.({
        kind: "metrics",
        rssBytes: process.memoryUsage().rss,
        loopDelayMilliseconds: {
            p95: delay.percentile(95) / 1e6,
            p99: delay.percentile(99) / 1e6,
            max: delay.max / 1e6,
        },
    });
    delay.disable();
    process.disconnect();
}
