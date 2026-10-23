import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { DirectAcpAgentSpecification } from "../../src/agent/specification/agent-specification.ts";

class HistoryAgentSpecification extends DirectAcpAgentSpecification {
    readonly id = "claude";
    readonly label = "Claude Code";
    readonly agentExecutable = "controlled-acp";
    readonly adapterVersion = "1.0.0";
    override readonly minimumSupportedAgentVersion = "1.0.0";
    override readonly maximumTestedAgentVersion = "1.0.0";
    constructor() {
        super("MOBIUS_TEST_CONTROLLED_ACP_PATH", []);
    }
}

import { withRealDaemon } from "../support/agents/real-daemon.ts";

// Persisted native history is owned by the controlled ACP peer, not by Mobius.
test.each([
    { name: "6000 messages", count: 6000, images: false },
    { name: "32 embedded images", count: 32, images: true },
])(
    "Given native history with $name, When its preview is loaded through the daemon, Then replay drains without losing messages or overflowing the output queue",
    async (scenario) => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-history-backpressure-"));
        const executable = join(directory, "controlled-acp");
        const stateDirectory = join(directory, "state");
        const nativeSessionId = "large-native-history";
        const count = scenario.count;
        const image = Buffer.concat([
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
            Buffer.alloc(750_000),
        ]).toString("base64");
        await mkdir(stateDirectory);
        await writeFile(
            executable,
            `#!${process.execPath}
if (process.argv.includes("--version")) {
    process.stdout.write("1.0.0\\n");
} else {
    process.argv.push("--agent-name", "Controlled ACP", "--agent-version", "1.0.0", "--http-mcp", "--no-additional-directories", "--no-delete-session", "--no-fork-session", "--no-embedded-context");
    await import(${JSON.stringify(new URL("./fixtures/acp-peer.ts", import.meta.url).toString())});
}
`,
            { mode: 0o700 },
        );
        await writeFile(
            join(stateDirectory, `${nativeSessionId}.json`),
            JSON.stringify({
                fastMode: false,
                history: Array.from({ length: count }, (_, index) => ({
                    messageId: `history-${index}`,
                    role: "user",
                    text: `History message ${index}`,
                    images: scenario.images ? [{ data: image, mimeType: "image/png" }] : [],
                })),
                mode: "code",
                model: "test-small",
                reasoningEffort: "medium",
                turnCount: 0,
            }),
        );
        try {
            await withRealDaemon(
                new HistoryAgentSpecification(),
                {
                    MOBIUS_FAKE_ACP_STATE_DIRECTORY: stateDirectory,
                    MOBIUS_TEST_CONTROLLED_ACP_PATH: executable,
                },
                async (peer) => {
                    peer.send(
                        encodeSessionPreviewHistoryPageLoad({
                            additionalDirectoryIds: [],
                            agentId: "claude",
                            bindingId: peer.bindingId,
                            cursor: null,
                            directoryId: "default",
                            eventLimit: 10000,
                            kind: "session.preview-history.page.load",
                            requestId: "large-history-preview",
                            sessionId: nativeSessionId,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind !== "session.preview-history.page.loaded") {
                            continue;
                        }
                        const page = decodeSessionPreviewHistoryPageLoaded(message);
                        const text = page.events.events.events.flatMap((event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text"
                                ? [event.payload.content.text]
                                : [],
                        );
                        if (scenario.images) {
                            expect(
                                page.events.events.events.filter(
                                    (event) =>
                                        event.type === "acp" &&
                                        event.payload.sessionUpdate === "user_message_chunk" &&
                                        event.payload.content.type === "external_image",
                                ),
                            ).toHaveLength(count);
                        }
                        expect(text).toEqual(Array.from({ length: count }, (_, index) => `History message ${index}`));
                        break;
                    }
                },
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    },
);
