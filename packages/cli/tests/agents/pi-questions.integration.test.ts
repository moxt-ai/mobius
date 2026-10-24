import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEvent,
    decodeSessionOperationFailedEvent,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import { PiAgentSpecification } from "../../src/agent/specification/vendors/pi-agent.ts";
import type { Timer } from "../../src/util/timer.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const forest = String.fromCodePoint(0x68ee, 0x6797);
const unicodeName = `${String.fromCodePoint(0x59da)} 🌊`;
const firstLine = String.fromCodePoint(0x7b2c, 0x4e00, 0x884c);
const editedDraft = `${String.fromCodePoint(0x6539, 0x5199)}${firstLine}\nSecond line\n${String.fromCodePoint(0x7b2c, 0x4e09, 0x884c)}`;
const prefill = `${firstLine}\nSecond line`;

const questionExtension = `export default function (pi) {
    pi.registerTool({
        name: "ask_questions",
        label: "Ask questions",
        description: "Ask native Pi questions and report their answers",
        parameters: { type: "object", properties: {} },
        async execute(_id, _params, _signal, _update, ctx) {
            const answers = [
                await ctx.ui.select("Theme", ["Ocean", ${JSON.stringify(forest)}, "Sunset"]),
                await ctx.ui.confirm("Proceed", "Continue this task?"),
                await ctx.ui.confirm("Remove", "Remove the draft?"),
                await ctx.ui.input("Name", "Unicode welcome"),
                await ctx.ui.input("Empty value", "An empty answer is valid"),
                await ctx.ui.editor("Draft", ${JSON.stringify(prefill)}),
                await ctx.ui.editor("Empty draft", "Clear this"),
                await ctx.ui.input("Cancelled", "Cancel this question"),
                await ctx.ui.select("Declined choice", ["One", "Two"]),
                await ctx.ui.confirm("Cancelled confirmation", "Cancel this confirmation"),
                await ctx.ui.editor("Cancelled draft", "Leave this draft unchanged"),
            ];
            return { content: [{ type: "text", text: "PI_ANSWERS=" + JSON.stringify(answers) }], details: {} };
        },
    });
}`;

test.each(["new", "imported"] as const)(
    "Given a real Pi session (%s) asks native questions, When the user selects, confirms, types, edits and cancels through the daemon, Then the same tool receives the exact answers",
    async (origin) => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_QUESTIONS_COMPLETE", {
            toolPrompt: "Ask all the native questions",
            toolSequence: [{ name: "ask_questions", input: "{}" }],
        });
        await using agent = await PiFixture.create(provider);
        await agent.installExtension("questions.js", questionExtension);
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const sessionId = origin === "imported" ? await importSavedSession(peer, agent) : peer.sessionId;
            const commandId = randomUUID();
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
                    prompt: "Ask all the native questions",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
            const answers = [forest, "yes", "no", unicodeName, "", editedDraft, ""];
            const interactionIds = new Set<string>();
            let requests = 0;
            let result = "";
            let reply = "";
            for (;;) {
                const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata") {
                    if (event.payload.kind === "session.permission.requested") {
                        throw new Error("Pi questions must use information requests, not permissions");
                    }
                    if (event.payload.kind === "session.elicitation.requested") {
                        const request = event.payload.event;
                        expect(request.commandId).toBe(commandId);
                        expect(interactionIds.has(request.interactionId)).toBe(false);
                        interactionIds.add(request.interactionId);
                        expect(request.fields).toHaveLength(1);
                        const field = request.fields[0];
                        if (field === undefined) {
                            throw new Error("Missing question field");
                        }
                        if (requests === 0) {
                            expect(field.type).toBe("select");
                            expect(field.options.map((option) => option.value)).toEqual(["Ocean", forest, "Sunset"]);
                        }
                        if (requests === 5) {
                            expect(field.defaultStringValue).toBe(prefill);
                            expect(field.multiline).toBe(true);
                        }
                        peer.send(
                            encodeSessionElicitationRespondCommand({
                                action: requests === 8 ? "decline" : requests >= 7 ? "cancel" : "accept",
                                content: requests >= 7 ? "" : JSON.stringify({ [field.name]: answers[requests] }),
                                interactionId: request.interactionId,
                                kind: "session.elicitation.respond",
                                sessionId,
                            }),
                        );
                        requests += 1;
                    }
                    if (event.payload.kind === "prompt.failed") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed") {
                        expect(event.payload.commandId).toBe(commandId);
                        expect(event.payload.stopReason).toBe("end_turn");
                        break;
                    }
                } else if (event.type === "acp") {
                    if (event.payload.sessionUpdate === "tool_call_update" && event.payload.rawOutput !== undefined) {
                        result += JSON.stringify(event.payload.rawOutput);
                    }
                    if (
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        reply += event.payload.content.text;
                    }
                }
            }
            expect(requests).toBe(11);
            expect(result).toContain(
                JSON.stringify(
                    "PI_ANSWERS=" +
                        JSON.stringify([
                            forest,
                            true,
                            false,
                            unicodeName,
                            "",
                            editedDraft,
                            "",
                            null,
                            null,
                            false,
                            null,
                        ]),
                ),
            );
            expect(reply).toContain("PI_QUESTIONS_COMPLETE");
        });
    },
);

async function importSavedSession(peer: RealDaemonPeer, agent: PiFixture): Promise<string> {
    const seedPrompt = "Save this native conversation for import";
    await agent.seedSession(peer.workspace, seedPrompt, peer.signal);
    const identity = { additionalDirectoryIds: [], agentId: "pi", bindingId: peer.bindingId, directoryId: "default" };
    const discoveryId = randomUUID();
    const listId = randomUUID();
    peer.send(
        encodeNativeSessionCommand({
            ...identity,
            action: "list",
            cursor: null,
            kind: "native.session.request",
            requestId: listId,
            sessionId: discoveryId,
        }),
    );
    let entryId = "";
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) !== "native.session.result") {
            continue;
        }
        const result = decodeNativeSessionResult(message);
        if (result.action !== "list" || result.requestId !== listId) {
            continue;
        }
        const source = result.entries.find((entry) => entry.title === seedPrompt);
        if (source === undefined) {
            throw new Error("Missing saved Pi session");
        }
        expect(source.mobiusSessionIds).toEqual([]);
        entryId = source.entryId;
        break;
    }
    const importId = randomUUID();
    const sessionId = randomUUID();
    peer.send(
        encodeNativeSessionCommand({
            ...identity,
            action: "import",
            entryId,
            kind: "native.session.request",
            requestId: importId,
            sessionId: discoveryId,
            targetSessionId: sessionId,
        }),
    );
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) === "session.operation.failed") {
            throw new Error(message);
        }
        if (decodeMessageKind(message) !== "native.session.result") {
            continue;
        }
        const result = decodeNativeSessionResult(message);
        if (result.action === "import" && result.requestId === importId) {
            expect(result.ready.restored).toBe(true);
            return result.ready.sessionId;
        }
    }
}

function sendQuestionPrompt(peer: RealDaemonPeer, sessionId: string, prompt: string): string {
    const commandId = randomUUID();
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
            sessionId,
            targetCommandId: "",
        }),
    );
    return commandId;
}

for (const ending of ["stop", "timeout"] as const) {
    test(`Given a real Pi question is pending, When the ${ending === "stop" ? "user stops its turn" : "question deadline expires"}, Then the card is cancelled and a late answer cannot affect a follow-up`, async () => {
        const prompt = "Ask one native question";
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_FOLLOWUP_COMPLETE", {
            toolPrompt: prompt,
            toolSequence: [{ name: "ask_one", input: "{}" }],
        });
        await using agent = await PiFixture.create(provider);
        await agent.installExtension(
            "one-question.js",
            `export default function (pi) {
            pi.registerTool({
                name: "ask_one", label: "Ask one", description: "Ask one question",
                parameters: { type: "object", properties: {} },
                async execute(_id, _params, _signal, _update, ctx) {
                    const answer = await ctx.ui.input("Pending input", "Answer or cancel", { timeout: 5000 });
                    return { content: [{ type: "text", text: "PI_SINGLE=" + JSON.stringify(answer ?? null) }], details: {} };
                },
            });
        }`,
        );
        // Keep real transport batching live while advancing only the adapter's dialog clock.
        const scheduleTransport = setTimeout;
        const cancelTransport = clearTimeout;
        const transportTimer: Timer = {
            schedule: (callback, milliseconds) => {
                const handle = scheduleTransport(callback, milliseconds);
                return { cancel: () => cancelTransport(handle) };
            },
        };
        try {
            await withRealDaemon(
                new PiAgentSpecification(),
                agent.environment,
                async (peer) => {
                    const sessionId = await prepareNewRealSession(peer, "pi");
                    if (ending === "timeout") {
                        vi.useFakeTimers({
                            now: new Date("2026-10-24T00:00:00Z"),
                            toFake: ["Date", "setTimeout", "clearTimeout"],
                        });
                    }
                    const commandId = sendQuestionPrompt(peer, sessionId, prompt);
                    let interactionId = "";
                    for (;;) {
                        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "session.elicitation.requested"
                        ) {
                            const request = event.payload.event;
                            interactionId = request.interactionId;
                            break;
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.completed")
                        ) {
                            throw new Error(JSON.stringify(event));
                        }
                    }
                    if (ending === "stop") {
                        peer.send(encodeSessionCancelCommand({ commandId, kind: "session.cancel", sessionId }));
                    } else {
                        await vi.advanceTimersByTimeAsync(5000);
                    }
                    let resolved = 0;
                    for (;;) {
                        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type !== "lifecycle-metadata") {
                            continue;
                        }
                        if (event.payload.kind === "session.elicitation.resolved") {
                            expect(event.payload.event.interactionId).toBe(interactionId);
                            expect(event.payload.event.action).toBe("cancel");
                            resolved += 1;
                        }
                        if (event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                            expect(event.payload.stopReason).toBe(ending === "stop" ? "cancelled" : "end_turn");
                            break;
                        }
                    }
                    expect(resolved).toBe(1);
                    vi.useRealTimers();
                    peer.send(
                        encodeSessionElicitationRespondCommand({
                            action: "accept",
                            content: '{"value":"STALE_ANSWER"}',
                            interactionId,
                            kind: "session.elicitation.respond",
                            sessionId,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        if (decodeMessageKind(message) !== "session.operation.failed") {
                            continue;
                        }
                        const failure = decodeSessionOperationFailedEvent(message);
                        expect(failure.code).toBe("elicitation_request_not_found");
                        break;
                    }
                    const followup = sendQuestionPrompt(peer, sessionId, "Continue after the question was cancelled");
                    let reply = "";
                    for (;;) {
                        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            reply += event.payload.content.text;
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === followup
                        ) {
                            break;
                        }
                    }
                    expect(reply).toContain("PI_FOLLOWUP_COMPLETE");
                },
                "embedded",
                undefined,
                transportTimer,
            );
        } finally {
            vi.useRealTimers();
        }
    });
}

test("Given real Pi asks a question before a daemon disconnect, When the daemon reconnects and the user continues, Then the interrupted question cannot consume the new answer", async () => {
    const prompt = "Ask before disconnect";
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_RECONNECTED", {
        toolPrompt: prompt,
        toolSequence: [{ name: "ask_disconnect", input: "{}" }],
    });
    await using agent = await PiFixture.create(provider);
    await agent.installExtension(
        "disconnect-question.js",
        `export default function (pi) {
        pi.registerTool({ name: "ask_disconnect", label: "Ask", description: "Ask before disconnect",
            parameters: { type: "object", properties: {} },
            async execute(_id, _params, _signal, _update, ctx) {
                const answer = await ctx.ui.input("Interrupted question", "This turn will disconnect");
                return { content: [{ type: "text", text: JSON.stringify(answer ?? null) }], details: {} };
            },
        });
    }`,
    );
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        sendQuestionPrompt(peer, peer.sessionId, prompt);
        let interactionId = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata" && event.payload.kind === "session.elicitation.requested") {
                interactionId = event.payload.event.interactionId;
                break;
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
        }
        await peer.restart();
        const commandId = sendQuestionPrompt(peer, peer.sessionId, "Continue after reconnect without asking again");
        let reply = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "session.elicitation.requested") {
                throw new Error("The interrupted question was replayed");
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                break;
            }
        }
        expect(reply).toContain("PI_RECONNECTED");
        peer.send(
            encodeSessionElicitationRespondCommand({
                action: "accept",
                content: '{"value":"STALE_ANSWER"}',
                interactionId,
                kind: "session.elicitation.respond",
                sessionId: peer.sessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.operation.failed") {
                continue;
            }
            expect(decodeSessionOperationFailedEvent(message).code).toBe("elicitation_request_not_found");
            break;
        }
    });
});

test("Given real Pi requests fields outside the supported bounds, When the question reaches the daemon, Then the user sees a clear failure and Pi receives cancellation instead of truncated content", async () => {
    const prompt = "Ask oversized native questions";
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_BOUNDS_COMPLETE", {
        toolPrompt: prompt,
        toolSequence: [{ name: "ask_bounds", input: "{}" }],
    });
    await using agent = await PiFixture.create(provider);
    await agent.installExtension(
        "bounded-questions.js",
        `export default function (pi) {
        pi.registerTool({ name: "ask_bounds", label: "Ask", description: "Ask oversized questions",
            parameters: { type: "object", properties: {} },
            async execute(_id, _params, _signal, _update, ctx) {
                const answers = [await ctx.ui.select("Long choice", ["x".repeat(256)]), await ctx.ui.editor("Long draft", "x".repeat(10001))];
                return { content: [{ type: "text", text: "PI_REJECTED=" + JSON.stringify(answers) }], details: {} };
            },
        });
    }`,
    );
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const commandId = sendQuestionPrompt(peer, peer.sessionId, prompt);
        let text = "";
        let result = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                text += event.payload.content.text;
            }
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "tool_call_update" &&
                event.payload.rawOutput !== undefined
            ) {
                result += JSON.stringify(event.payload.rawOutput);
            }
            if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "session.elicitation.requested" ||
                    event.payload.kind === "session.permission.requested" ||
                    event.payload.kind === "prompt.failed")
            ) {
                throw new Error(JSON.stringify(event));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                break;
            }
        }
        expect(text.match(/unsupported or oversized fields/gu)).toHaveLength(2);
        expect(text).toContain("PI_BOUNDS_COMPLETE");
        expect(result).toContain("PI_REJECTED=[null,null]");
    });
});
