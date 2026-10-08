import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
    decodeFileChunkEvent,
    decodeMessageKind,
    decodeRecordedSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveHistoryV2PageLoaded,
    encodeFileReadCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    type SessionEventV2,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

function chunk(kind: string, data: Buffer): Buffer {
    const type = Buffer.from(kind);
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    type.copy(output, 4);
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
        }
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return output;
}

// A real raster with incompressible pixels exercises Pi's image reader and
// native replay, rather than padding a tiny picture with unrelated bytes.
function imageFixture(side: number): Buffer {
    const pixels = Buffer.alloc((side * 3 + 1) * side);
    let state = 0x496499;
    for (let y = 0; y < side; y++) {
        for (let x = 1; x <= side * 3; x++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            pixels[y * (side * 3 + 1) + x] = state & 255;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function imageKeys(events: readonly SessionEventV2[]): readonly string[] {
    return events.flatMap((event) => {
        if (
            event.type !== "acp" ||
            (event.payload.sessionUpdate !== "tool_call" && event.payload.sessionUpdate !== "tool_call_update")
        ) {
            return [];
        }
        return (event.payload.content ?? []).flatMap((item) =>
            item.type === "content" && item.content.type === "external_image" ? [item.content.imageKey] : [],
        );
    });
}

for (const side of [128, 500]) {
    test(`Given real Pi reads a ${side}px image, When its reply streams and native history reopens, Then clients retrieve identical bytes without base64 in tool output and can continue chatting`, async () => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "IMAGE_REPLY", { readPath: "picture.png" });
        await using agent = await PiFixture.create(provider);
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const image = imageFixture(side);
            const key = createHash("sha256").update(image).digest("hex");
            await writeFile(join(peer.workspace, "picture.png"), image);
            const sendPrompt = (commandId: string, prompt: string): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "pi",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt,
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    }),
                );
            const finish = async (): Promise<readonly SessionEventV2[]> => {
                const events: SessionEventV2[] = [];
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    expect(message).not.toContain(image.toString("base64"));
                    if (kind === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (kind === "session.event.v2") {
                        events.push(decodeSessionEventEnvelopeV2(message).event);
                    } else if (kind === "session.event") {
                        const event = decodeRecordedSessionEvent(decodeSessionEventEnvelope(message).payload);
                        if (event.kind === "session.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (event.kind === "session.completed") {
                            return events;
                        }
                    }
                }
            };
            sendPrompt("image-turn", "Use the read tool to inspect picture.png, then reply");
            expect(imageKeys(await finish())).toContain(key);
            peer.send(
                encodeSessionLiveHistoryV2PageLoad({
                    additionalDirectoryIds: [],
                    agentId: "pi",
                    bindingId: peer.bindingId,
                    cursor: null,
                    directoryId: "default",
                    eventLimit: 50,
                    kind: "session.live-history.v2.page.load",
                    requestId: "image-history",
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind === "session.live-history.v2.page.loaded") {
                    expect(message).not.toContain(image.toString("base64"));
                    expect(message.length).toBeLessThan(50_000);
                    expect(imageKeys(decodeSessionLiveHistoryV2PageLoaded(message).events.history.events)).toContain(
                        key,
                    );
                    break;
                }
            }
            peer.send(
                encodeFileReadCommand({
                    kind: "file.read",
                    maxBytes: 2_000_000,
                    path: `mobius-content:image:${key}`,
                    requestId: "image-download",
                    sessionId: peer.sessionId,
                }),
            );
            const chunks: Buffer[] = [];
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "file.failed") {
                    throw new Error(message);
                }
                if (kind === "file.chunk") {
                    chunks.push(Buffer.from(decodeFileChunkEvent(message).data, "base64"));
                } else if (kind === "file.end") {
                    break;
                }
            }
            expect(Buffer.concat(chunks)).toEqual(image);
            sendPrompt("continue-turn", "Continue with a short reply, without using tools");
            await finish();
        });
    });
}
