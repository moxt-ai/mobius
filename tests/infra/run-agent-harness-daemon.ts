import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { AuditStore } from "../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../packages/cli/src/config.ts";
import { runDaemon } from "../../packages/cli/src/run-daemon.ts";
import { mobiusApiPath } from "../../packages/protocol/src/index.ts";
import { defaultFakeAgentHarness, fakeAgentHarness } from "./agent-harness.ts";

const configurationSchema = v.strictObject({
    channelId: v.string(),
    credential: v.string(),
    directory: v.string(),
    endpoint: v.string(),
    harnessState: v.string(),
    workspace: v.string(),
});

const configurationPath = process.argv[2];
if (configurationPath === undefined) {
    throw new Error("The controlled Agent harness daemon configuration is required");
}
const configuration = v.parse(configurationSchema, JSON.parse(await readFile(configurationPath, "utf8")));
const relayUrl = new URL(mobiusApiPath("/v1/runtimes/connect"), configuration.endpoint);
relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
relayUrl.searchParams.set("token", configuration.credential);

const cancellation = new AbortController();
const stop = (): void => cancellation.abort(new Error("Controlled Agent harness daemon stopped"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
    await runDaemon(
        createDaemonConfig(
            {
                channelId: configuration.channelId,
                defaultWorkspace: configuration.workspace,
                relayUrl,
            },
            [fakeAgentHarness(defaultFakeAgentHarness, configuration.harnessState)],
            [],
            new DaemonLocalContext(configuration.directory, process.env),
        ),
        new AuditStore(),
        cancellation.signal,
        undefined,
        {
            onConnectionStatus: (status) => {
                if (status === "online" && process.connected) {
                    process.send?.({ kind: "ready" });
                }
            },
        },
    );
} catch (cause) {
    if (!cancellation.signal.aborted) {
        throw cause;
    }
} finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (process.connected) {
        process.disconnect();
    }
}
