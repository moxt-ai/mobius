#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import { FAKE_ACP_AGENT_NAME } from "./index.ts";
import { promptUsageResponse } from "./usage.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPromptText(value: unknown): string {
    if (!Array.isArray(value)) {
        return "";
    }

    let text = "";
    for (const block of value) {
        if (!isRecord(block) || block["type"] !== "text") {
            continue;
        }
        const blockText = block["text"];
        if (typeof blockText === "string") {
            text += blockText;
        }
    }
    return text;
}

function readAgentName(): string {
    const optionIndex = process.argv.indexOf("--agent-name");
    if (optionIndex < 0) {
        return "";
    }
    return process.argv[optionIndex + 1] ?? "";
}

function readAgentVersion(): string {
    const optionIndex = process.argv.indexOf("--agent-version");
    if (optionIndex < 0) {
        return "1.0.0";
    }
    return process.argv[optionIndex + 1] ?? "";
}

function exitsAfterSessionCreation(): boolean {
    return process.argv.includes("--exit-after-session-creation");
}

function persistsEmptySessions(): boolean {
    return !process.argv.includes("--persist-after-first-prompt");
}

function failFirstRuntimeInitialization(clientCapabilities: unknown, selectedAgentName: string): void {
    if (
        process.env["MOBIUS_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION"] !== selectedAgentName ||
        !isRecord(clientCapabilities) ||
        !Reflect.has(clientCapabilities, "plan")
    ) {
        return;
    }
    const stateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (stateDirectory === undefined) {
        throw new Error("Fake ACP state directory is required");
    }
    mkdirSync(stateDirectory, { recursive: true });
    const markerPath = join(
        stateDirectory,
        `${selectedAgentName.toLowerCase().replaceAll(" ", "-")}.runtime-initialization-failed`,
    );
    if (existsSync(markerPath)) {
        return;
    }
    writeFileSync(markerPath, `${process.pid.toString()}\n`, {
        flag: "wx",
        mode: 0o600,
    });
    throw new Error("Transient fake ACP initialization failure");
}

function countPromptBlock(prompt: readonly acp.ContentBlock[], type: string): number {
    return prompt.filter((block) => block.type === type).length;
}

function readableWebStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    let streamOpen = true;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!streamOpen) {
                    return;
                }
                if (chunk instanceof Uint8Array) {
                    controller.enqueue(new Uint8Array(chunk));
                    return;
                }
                streamOpen = false;
                controller.error(new Error("ACP stdin produced a non-binary chunk"));
            });
            input.once("end", () => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.close();
            });
            input.once("error", (error) => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.error(error);
            });
        },
        cancel() {
            streamOpen = false;
        },
    });
}

function writableWebStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                output.write(chunk, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

class FakeSessionState {
    readonly fastMode: boolean;
    readonly mode: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly turnCount: number;

    constructor(
        turnCount: number,
        model = "test-small",
        reasoningEffort = process.argv.includes("--effort-provider-default") ? "" : "medium",
        fastMode = false,
        mode = "code",
    ) {
        this.fastMode = fastMode;
        this.mode = mode;
        this.model = model;
        this.reasoningEffort = reasoningEffort;
        this.turnCount = turnCount;
    }

    readonly withTurnCount = (turnCount: number): FakeSessionState =>
        new FakeSessionState(turnCount, this.model, this.reasoningEffort, this.fastMode, this.mode);

    readonly withMode = (mode: string): FakeSessionState =>
        new FakeSessionState(this.turnCount, this.model, this.reasoningEffort, this.fastMode, mode);

    readonly withConfig = (configId: string, value: unknown): FakeSessionState => {
        if (configId === "model" && typeof value === "string") {
            return new FakeSessionState(this.turnCount, value, this.reasoningEffort, this.fastMode, this.mode);
        }
        if (configId === "reasoning_effort" && typeof value === "string") {
            return new FakeSessionState(this.turnCount, this.model, value, this.fastMode, this.mode);
        }
        if (configId === "fast_mode" && typeof value === "boolean") {
            return new FakeSessionState(this.turnCount, this.model, this.reasoningEffort, value, this.mode);
        }
        throw new Error("Unknown fake ACP configuration option");
    };
}

const nativeHistory = new Map<
    string,
    {
        readonly messageId: string;
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly images?: readonly {
            readonly data: string;
            readonly mimeType: string;
        }[];
    }[]
>();

const nativeMetadata = new Map<
    string,
    {
        readonly cwd: string;
        readonly additionalDirectories: readonly string[];
        readonly title: string;
    }
>();

// Observe real subprocess lifetime at the external Agent boundary without inspecting manager internals.
const processDirectory = process.env["MOBIUS_FAKE_ACP_PROCESS_DIRECTORY"] ?? "";
const processMarkerId = process.env["MOBIUS_FAKE_ACP_PROCESS_ID"] ?? "";
const processMarkerPath =
    processDirectory.length === 0 || processMarkerId.length === 0
        ? ""
        : join(processDirectory, `${encodeURIComponent(processMarkerId)}.process`);
if (processMarkerPath.length > 0) {
    mkdirSync(processDirectory, { recursive: true });
    writeFileSync(processMarkerPath, String(process.pid), { flag: "wx" });
}
// The real Codex writer cannot be shared safely or deterministically in tests.
// Model its exclusive ownership at the external Agent boundary with real files.
const writerFiles = new Map<string, string>();
function acquireWriter(sessionId: string): void {
    const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined || !process.argv.includes("--exclusive-writer") || writerFiles.has(sessionId)) {
        return;
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${encodeURIComponent(sessionId)}.writer`);
    writeFileSync(path, String(process.pid), { flag: "wx" });
    writerFiles.set(sessionId, path);
}
function releaseWriter(sessionId: string): void {
    const path = writerFiles.get(sessionId);
    if (path === undefined) {
        return;
    }
    unlinkSync(path);
    writerFiles.delete(sessionId);
}
process.on("exit", () => {
    for (const id of writerFiles.keys()) {
        releaseWriter(id);
    }
    if (processMarkerPath.length > 0 && existsSync(processMarkerPath)) {
        unlinkSync(processMarkerPath);
    }
});
process.on("SIGTERM", () => process.exit(0));

function readPersistedState(sessionId: string): FakeSessionState {
    const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        throw new Error("Fake ACP persistence is not configured");
    }
    const path = join(directory, `${encodeURIComponent(sessionId)}.json`);
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("Invalid fake ACP state");
    }
    const history = Reflect.get(decoded, "history");
    if (Array.isArray(history)) {
        nativeHistory.set(
            sessionId,
            history.map((message: unknown, index: number) => {
                if (typeof message !== "object" || message === null) {
                    throw new Error("Invalid saved message");
                }
                const role = Reflect.get(message, "role");
                const text = Reflect.get(message, "text");
                const persistedMessageId = Reflect.get(message, "messageId");
                if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
                    throw new Error("Invalid saved message");
                }
                const images: unknown = Reflect.get(message, "images");
                const messageId =
                    typeof persistedMessageId === "string" ? persistedMessageId : `saved-${index.toString()}`;
                if (images === undefined) {
                    return { messageId, role, text };
                }
                if (!Array.isArray(images)) {
                    throw new Error("Invalid saved images");
                }
                return {
                    role,
                    text,
                    messageId,
                    images: images.map((image: unknown) => {
                        if (typeof image !== "object" || image === null) {
                            throw new Error("Invalid saved image");
                        }
                        const data: unknown = Reflect.get(image, "data");
                        const mimeType: unknown = Reflect.get(image, "mimeType");
                        if (typeof data !== "string" || typeof mimeType !== "string") {
                            throw new Error("Invalid saved image");
                        }
                        return { data, mimeType };
                    }),
                };
            }),
        );
    }
    const turnCount = Reflect.get(decoded, "turnCount");
    const model = Reflect.get(decoded, "model");
    const reasoningEffort = Reflect.get(decoded, "reasoningEffort");
    const fastMode = Reflect.get(decoded, "fastMode");
    const mode = Reflect.get(decoded, "mode");
    const cwd = Reflect.get(decoded, "cwd");
    const title = Reflect.get(decoded, "title");
    const additional = Reflect.get(decoded, "additionalDirectories");
    if (
        typeof cwd === "string" &&
        typeof title === "string" &&
        Array.isArray(additional) &&
        additional.every((value): value is string => typeof value === "string")
    ) {
        nativeMetadata.set(sessionId, {
            cwd,
            title,
            additionalDirectories: additional,
        });
    }
    if (
        typeof turnCount !== "number" ||
        typeof model !== "string" ||
        typeof reasoningEffort !== "string" ||
        typeof fastMode !== "boolean" ||
        (mode !== undefined && typeof mode !== "string")
    ) {
        throw new Error("Invalid fake ACP state");
    }
    return new FakeSessionState(turnCount, model, reasoningEffort, fastMode, typeof mode === "string" ? mode : "code");
}

function persistState(sessionId: string, state: FakeSessionState): void {
    const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        return;
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, `${encodeURIComponent(sessionId)}.json`),
        JSON.stringify({
            ...state,
            ...nativeMetadata.get(sessionId),
            history: nativeHistory.get(sessionId) ?? [],
        }),
    );
}

function configOptions(state: FakeSessionState): acp.SessionConfigOption[] {
    let options: acp.SessionConfigOption[] = [
        {
            category: "model",
            currentValue: state.model,
            description: "Model used by the fake ACP agent",
            id: "model",
            name: "Model",
            options: [
                { name: "Test Small", value: "test-small" },
                { name: "Test Large", value: "test-large" },
            ],
            type: "select",
        },
        {
            category: "thought_level",
            currentValue: state.reasoningEffort,
            description: "Reasoning effort used by the fake ACP agent",
            id: "reasoning_effort",
            name: "Reasoning effort",
            options: process.argv.includes("--effort-provider-default")
                ? [
                      { name: "Provider default", value: "" },
                      { name: "Low", value: "low" },
                      { name: "Medium", value: "medium" },
                      { name: "High", value: "high" },
                  ]
                : [
                      { name: "Low", value: "low" },
                      { name: "Medium", value: "medium" },
                      { name: "High", value: "high" },
                  ],
            type: "select",
        },
        {
            category: "model_config",
            currentValue: state.fastMode,
            description: "Use the lower latency execution path",
            id: "fast_mode",
            name: "Fast mode",
            type: "boolean",
        },
    ];
    if (process.argv.includes("--model-last-at-option-limit")) {
        const model = options.find((option) => option.category === "model");
        if (model === undefined) {
            throw new Error("Fake ACP model configuration is required");
        }
        const filler: acp.SessionConfigOption[] = [];
        for (let index = 0; index < 98; index += 1) {
            filler.push({
                category: "advanced",
                currentValue: false,
                description: "Fills the Agent configuration boundary",
                id: `filler_${index.toString()}`,
                name: `Filler ${index.toString()}`,
                type: "boolean",
            });
        }
        options = [...filler, model];
    }
    if (process.argv.includes("--without-model")) {
        options = options.filter((option) => option.category !== "model");
    }
    if (
        process.argv.includes("--without-reasoning-effort") ||
        (process.argv.includes("--reasoning-effort-for-test-large-only") && state.model !== "test-large")
    ) {
        options = options.filter((option) => option.category !== "thought_level");
    }
    if (process.argv.includes("--with-permission-option")) {
        options.push({
            category: "_mobius_permission",
            currentValue: "danger-full-access",
            description: "Untrusted Agent permission claim",
            id: "permission_mode",
            name: "Permissions",
            options: [{ name: "Full access", value: "danger-full-access" }],
            type: "select",
        });
    }
    return options;
}

function sessionModes(state: FakeSessionState): acp.SessionModeState {
    return {
        availableModes: [
            {
                description: "Make changes in the authorized workspace",
                id: "code",
                name: "Code",
            },
            {
                description: "Inspect the workspace and propose a plan",
                id: "plan",
                name: "Plan",
            },
        ],
        currentModeId: state.mode,
    };
}

function usesGrokLegacyConfig(): boolean {
    return process.argv.includes("--grok-legacy-config");
}

function sessionConfiguration(state: FakeSessionState): Readonly<Record<string, unknown>> {
    if (!usesGrokLegacyConfig()) {
        return {
            configOptions: configOptions(state),
            modes: sessionModes(state),
        };
    }
    return {
        _meta: {
            "x.ai/sessionConfig": {
                options: [
                    {
                        category: "model",
                        id: "test-small",
                        label: "Test Small",
                        selected: state.model === "test-small",
                    },
                    {
                        category: "model",
                        id: "test-large",
                        label: "Test Large",
                        selected: state.model === "test-large",
                    },
                    ...["low", "medium", "high"].map((effort) => ({
                        category: "mode",
                        id: effort,
                        label: effort[0]?.toUpperCase() + effort.slice(1),
                        selected:
                            !process.argv.includes("--grok-legacy-no-selected-effort") &&
                            state.reasoningEffort === effort,
                    })),
                ],
            },
        },
        models: {
            availableModels: [
                {
                    _meta: { supportsReasoningEffort: true },
                    modelId: "test-small",
                    name: "Test Small",
                },
                {
                    _meta: { supportsReasoningEffort: true },
                    modelId: "test-large",
                    name: "Test Large",
                },
            ],
            currentModelId: state.model,
        },
    };
}

const sessions = new Map<string, FakeSessionState>();
const turnCancellations = new Map<string, AbortController>();
const steeringWaiters = new Map<string, PromiseWithResolvers<string>>();
let listCommandsAnnounced = false;
const agentName = readAgentName();
const stream = acp.ndJsonStream(writableWebStream(process.stdout), readableWebStream(process.stdin));

acp.agent({ name: FAKE_ACP_AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, (context) => {
        failFirstRuntimeInitialization(context.params.clientCapabilities, agentName);
        return {
            _meta: {
                steering: { supported: !process.argv.includes("--no-steering") },
            },
            agentCapabilities: {
                _meta: {
                    claudeCode: { promptQueueing: !process.argv.includes("--no-prompt-queueing") },
                },
                loadSession: !process.argv.includes("--no-load-session"),
                ...(process.argv.includes("--http-mcp") ? { mcpCapabilities: { http: true } } : {}),
                promptCapabilities: {
                    embeddedContext: !process.argv.includes("--no-embedded-context"),
                    image: !process.argv.includes("--no-image-prompt"),
                },
                sessionCapabilities: {
                    ...(process.argv.includes("--no-additional-directories") ? {} : { additionalDirectories: {} }),
                    close: {},
                    ...(process.argv.includes("--load-only") ? {} : { resume: {} }),
                    ...(process.argv.includes("--no-native-sessions")
                        ? {}
                        : {
                              list: {},
                              ...(process.argv.includes("--no-delete-session") ? {} : { delete: {} }),
                              ...(process.argv.includes("--no-fork-session") ? {} : { fork: {} }),
                          }),
                },
            },
            authMethods:
                agentName === "Cursor CLI"
                    ? [
                          {
                              description: "Use the existing local Cursor login",
                              id: "cursor_login",
                              name: "Cursor Login",
                          },
                      ]
                    : agentName === "Grok Build"
                      ? [
                            {
                                description: "Use an xAI API key",
                                id: "xai.api_key",
                                name: "xAI API key",
                            },
                            {
                                description: "Use the existing local Grok login",
                                id: "grok.com",
                                name: "Grok",
                            },
                        ]
                      : agentName === "WorkBuddy"
                        ? [
                              {
                                  description: "Use the existing local WorkBuddy login",
                                  id: "external",
                                  name: "External login",
                              },
                          ]
                        : process.argv.includes("--external-authentication")
                          ? [
                                {
                                    description: "Use the existing local Agent login",
                                    id: "external",
                                    name: "External login",
                                },
                            ]
                          : [],
            agentInfo: { name: "Mobius test agent", version: readAgentVersion() },
            protocolVersion: acp.PROTOCOL_VERSION,
        };
    })
    .onRequest(acp.methods.agent.session.new, async (context) => {
        if (process.argv.includes("--authentication-required")) {
            throw acp.RequestError.authRequired();
        }
        const sessionId = crypto.randomUUID();
        acquireWriter(sessionId);
        const state = new FakeSessionState(0);
        nativeMetadata.set(sessionId, {
            cwd: context.params.cwd,
            additionalDirectories: context.params.additionalDirectories ?? [],
            title: "",
        });
        sessions.set(sessionId, state);
        if (persistsEmptySessions()) {
            persistState(sessionId, state);
        }
        if (process.argv.includes("--announce-config-while-creating")) {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: process.argv.includes("--announce-wrong-session-while-creating")
                    ? "unexpected-native-session"
                    : sessionId,
                update: {
                    configOptions: configOptions(state),
                    sessionUpdate: "config_option_update",
                },
            });
        }
        if (exitsAfterSessionCreation()) {
            setImmediate(() => process.exit(0));
        }
        return {
            ...sessionConfiguration(state),
            sessionId,
        };
    })
    .onRequest(acp.methods.agent.session.resume, (context) => {
        acquireWriter(context.params.sessionId);
        const state = readPersistedState(context.params.sessionId);
        sessions.set(context.params.sessionId, state);
        return sessionConfiguration(state);
    })
    .onRequest(acp.methods.agent.session.list, async (context) => {
        if (process.argv.includes("--announce-commands-while-listing") && !listCommandsAnnounced) {
            const activeSessionId = sessions.keys().next().value ?? "native-browser-notification";
            listCommandsAnnounced = true;
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: activeSessionId,
                update: {
                    availableCommands: [
                        {
                            description: "Inspect the current workspace",
                            input: { hint: "optional focus" },
                            name: "inspect",
                        },
                    ],
                    sessionUpdate: "available_commands_update",
                },
            });
        }
        const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        const stored =
            directory === undefined
                ? [...sessions.entries()]
                : readdirSync(directory)
                      .filter((name) => name.endsWith(".json"))
                      .map((name) => {
                          const id = decodeURIComponent(name.slice(0, -5));
                          return [id, readPersistedState(id)] satisfies readonly [string, FakeSessionState];
                      });
        const candidates = stored
            .flatMap(([id, state]) => {
                const metadata = nativeMetadata.get(id);
                return state.turnCount === 0 ||
                    metadata === undefined ||
                    (context.params.cwd != null && context.params.cwd !== metadata.cwd)
                    ? []
                    : [
                          {
                              sessionId: id,
                              cwd: metadata.cwd,
                              additionalDirectories: [...metadata.additionalDirectories],
                              title: process.argv.includes("--oversized-native-session-title")
                                  ? `${metadata.title}${"x".repeat(600)}`
                                  : metadata.title,
                              updatedAt: "2026-09-05T00:00:00Z",
                          },
                      ];
            })
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
        const start = context.params.cursor == null ? 0 : Number(context.params.cursor);
        if (!Number.isSafeInteger(start) || start < 0) {
            throw new Error("Invalid native session cursor");
        }
        return {
            sessions: candidates.slice(start, start + 2),
            ...(start + 2 < candidates.length ? { nextCursor: String(start + 2) } : {}),
        };
    })
    .onRequest(acp.methods.agent.session.fork, (context) => {
        const state = readPersistedState(context.params.sessionId);
        const metadata = nativeMetadata.get(context.params.sessionId);
        if (metadata === undefined) {
            throw new Error("Unknown native session");
        }
        const sessionId = process.argv.includes("--reuse-session-on-fork")
            ? context.params.sessionId
            : crypto.randomUUID();
        acquireWriter(sessionId);
        nativeMetadata.set(sessionId, {
            ...metadata,
            cwd: context.params.cwd,
            additionalDirectories: context.params.additionalDirectories ?? [],
        });
        const sourceHistory = nativeHistory.get(context.params.sessionId) ?? [];
        const fork = isRecord(context.params._meta) ? context.params._meta["jetbrains"] : undefined;
        const air = isRecord(fork) ? fork["air"] : undefined;
        const point = isRecord(air) ? air["fork"] : undefined;
        let forkHistory = [...sourceHistory];
        if (isRecord(point) && point["version"] === 1) {
            const requestedMessageId = point["messageId"];
            let messageIndex =
                typeof requestedMessageId === "string"
                    ? sourceHistory.findIndex((message) => message.messageId === requestedMessageId)
                    : -1;
            const requestedFingerprint = point["messageFingerprint"];
            const requestedOccurrence = point["messageOccurrence"];
            if (
                messageIndex < 0 &&
                typeof requestedFingerprint === "string" &&
                typeof requestedOccurrence === "number" &&
                Number.isSafeInteger(requestedOccurrence) &&
                requestedOccurrence > 0
            ) {
                const matches = sourceHistory
                    .map((message, index) => ({ index, message }))
                    .filter(
                        ({ message }) =>
                            message.role === "assistant" &&
                            `sha256:${createHash("sha256").update(message.text, "utf8").digest("hex")}` ===
                                requestedFingerprint,
                    );
                messageIndex = matches[requestedOccurrence - 1]?.index ?? -1;
            }
            if (messageIndex < 0 || sourceHistory[messageIndex]?.role !== "assistant") {
                throw new Error("Unknown fork point");
            }
            forkHistory = sourceHistory.slice(0, messageIndex + 1);
        }
        const forkedState = state.withTurnCount(forkHistory.filter((message) => message.role === "assistant").length);
        nativeHistory.set(sessionId, forkHistory);
        sessions.set(sessionId, forkedState);
        persistState(sessionId, forkedState);
        return {
            ...sessionConfiguration(forkedState),
            sessionId,
        };
    })
    .onRequest(acp.methods.agent.session.delete, (context) => {
        acquireWriter(context.params.sessionId);
        const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        if (directory !== undefined) {
            unlinkSync(join(directory, `${encodeURIComponent(context.params.sessionId)}.json`));
        }
        sessions.delete(context.params.sessionId);
        nativeMetadata.delete(context.params.sessionId);
        releaseWriter(context.params.sessionId);
        return {};
    })
    .onRequest(acp.methods.agent.session.load, async (context) => {
        acquireWriter(context.params.sessionId);
        const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        if (directory !== undefined && existsSync(join(directory, "pause-load"))) {
            writeFileSync(join(directory, "load-paused"), context.params.sessionId);
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    title: "Loading saved conversation",
                },
            });
            await waitForAbort(context.signal);
            context.signal.throwIfAborted();
        }
        const state = readPersistedState(context.params.sessionId);
        sessions.set(context.params.sessionId, state);
        for (const message of nativeHistory.get(context.params.sessionId) ?? []) {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                    content: { type: "text", text: message.text },
                    messageId: message.messageId,
                },
            });
            for (const image of message.images ?? []) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId: message.messageId,
                        // Codex ACP replays persisted images as named text links.
                        content:
                            readAgentName() === "Codex"
                                ? {
                                      type: "text",
                                      text: `[@image](data:${image.mimeType};base64,${image.data})`,
                                  }
                                : { type: "image", ...image },
                    },
                });
            }
        }
        return sessionConfiguration(state);
    })
    .onRequest(
        "session/set_model",
        (params: unknown) => params,
        (context) => {
            if (!usesGrokLegacyConfig()) {
                throw new Error("Legacy Grok session configuration is unavailable");
            }
            const params = context.params;
            if (!isRecord(params)) {
                throw new Error("Invalid Grok model request");
            }
            const sessionId = params["sessionId"];
            const modelId = params["modelId"];
            if (typeof sessionId !== "string" || typeof modelId !== "string") {
                throw new Error("Invalid Grok model request");
            }
            const state = sessions.get(sessionId);
            if (state === undefined) {
                throw new Error("Unknown ACP session");
            }
            if (modelId !== "test-small" && modelId !== "test-large") {
                throw new Error("Unknown Grok model");
            }
            let updated = state.withConfig("model", modelId);
            const metadata = params["_meta"];
            if (isRecord(metadata) && Object.hasOwn(metadata, "reasoningEffort")) {
                const effort = metadata["reasoningEffort"];
                if (effort === null) {
                    updated = updated.withConfig("reasoning_effort", "default");
                } else if (effort === "low" || effort === "medium" || effort === "high") {
                    updated = updated.withConfig("reasoning_effort", effort);
                } else {
                    throw new Error("Unknown Grok reasoning effort");
                }
            }
            sessions.set(sessionId, updated);
            persistState(sessionId, updated);
            return process.argv.includes("--invalid-grok-config-response") ? {} : { _meta: { model: { Ok: modelId } } };
        },
    )
    .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
        const state = sessions.get(context.params.sessionId);
        if (state === undefined) {
            throw new Error("Unknown ACP session");
        }
        if (process.argv.includes("--ignore-config-update")) {
            return { configOptions: configOptions(state) };
        }
        const updated = state.withConfig(context.params.configId, context.params.value);
        sessions.set(context.params.sessionId, updated);
        persistState(context.params.sessionId, updated);
        return { configOptions: configOptions(updated) };
    })
    .onRequest(acp.methods.agent.session.setMode, (context) => {
        const state = sessions.get(context.params.sessionId);
        if (state === undefined) {
            throw new Error("Unknown ACP session");
        }
        if (!sessionModes(state).availableModes.some((mode) => mode.id === context.params.modeId)) {
            throw new Error("Unknown fake ACP session mode");
        }
        const updated = state.withMode(context.params.modeId);
        sessions.set(context.params.sessionId, updated);
        persistState(context.params.sessionId, updated);
        return {};
    })
    .onRequest(
        "_session/steering",
        (params: unknown) => params,
        (context) => {
            if (!isRecord(context.params)) {
                throw new Error("Invalid steering request");
            }
            const sessionId = context.params["sessionId"];
            if (typeof sessionId !== "string") {
                throw new Error("Invalid steering session");
            }
            const waiter = steeringWaiters.get(sessionId);
            if (waiter === undefined) {
                return { outcome: "promptRequired", reason: "noRunningTurn" };
            }
            waiter.resolve(readPromptText(context.params["prompt"]));
            return { outcome: "injected" };
        },
    )
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
        const previousState = sessions.get(context.params.sessionId);
        if (previousState === undefined) {
            throw new Error("Unknown ACP session");
        }

        context.signal.throwIfAborted();
        const prompt = readPromptText(context.params.prompt);
        const turnNumber = previousState.turnCount + 1;
        const transcript = nativeHistory.get(context.params.sessionId) ?? [];
        transcript.push({
            messageId: `user-${turnNumber.toString()}`,
            role: "user",
            text: prompt,
            images: context.params.prompt.flatMap((block) =>
                block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
            ),
        });
        nativeHistory.set(context.params.sessionId, transcript);
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                sessionUpdate: "session_info_update",
                updatedAt: "2026-09-05T00:00:00Z",
            },
        });
        const metadata = nativeMetadata.get(context.params.sessionId);
        if (turnNumber === 1 && metadata !== undefined) {
            nativeMetadata.set(context.params.sessionId, {
                ...metadata,
                title: prompt,
            });
        }
        const state = previousState.withTurnCount(turnNumber);
        sessions.set(context.params.sessionId, state);
        persistState(context.params.sessionId, state);
        const cancellation = new AbortController();
        turnCancellations.set(context.params.sessionId, cancellation);
        const steering = Promise.withResolvers<string>();
        if (prompt === "wait for steering") {
            steeringWaiters.set(context.params.sessionId, steering);
        }
        try {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    _meta: { codex: { phase: "commentary" } },
                    content: {
                        text: "Gathering context",
                        type: "text",
                    },
                    messageId: `progress-${turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            });
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        text: "Inspecting ",
                        type: "text",
                    },
                    messageId: `reasoning-${turnNumber.toString()}`,
                    sessionUpdate: "agent_thought_chunk",
                },
            });
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        text: "the workspace",
                        type: "text",
                    },
                    messageId: `reasoning-${turnNumber.toString()}`,
                    sessionUpdate: "agent_thought_chunk",
                },
            });
            if (prompt === "stream verbose activity") {
                for (let index = 0; index < 64; index += 1) {
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: {
                            content: {
                                text: ` step-${index.toString()}`,
                                type: "text",
                            },
                            messageId: `reasoning-${turnNumber.toString()}`,
                            sessionUpdate: "agent_thought_chunk",
                        },
                    });
                }
            }
            if (prompt === "wait until cancelled") {
                await waitForAbort(cancellation.signal);
                return { stopReason: "cancelled" };
            }
            if (prompt === "wait for steering") {
                const instruction = await steering.promise;
                const text = `Steered: ${instruction}`;
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: { text, type: "text" },
                        messageId: `assistant-${turnNumber.toString()}`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
                transcript.push({ messageId: `assistant-${turnNumber.toString()}`, role: "assistant", text });
                persistState(context.params.sessionId, state);
                return { stopReason: "end_turn" };
            }
            const toolCallId = `tool-${turnNumber.toString()}`;

            if (prompt === "report Codex usage" || prompt === "report Claude usage") {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        cost: { amount: 0.125 * turnNumber, currency: "USD" },
                        sessionUpdate: "usage_update",
                        size: 200_000,
                        used: 50_000,
                    },
                });
            }

            if (prompt === "exercise ACP controls") {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        availableCommands: [
                            {
                                description: "Review the current workspace",
                                input: { hint: "optional focus" },
                                name: "review",
                            },
                        ],
                        sessionUpdate: "available_commands_update",
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "session_info_update",
                        title: "ACP feature session",
                        updatedAt: "2026-09-04T00:00:00.000Z",
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "session_info_update",
                        updatedAt: "2026-09-04T00:01:00.000Z",
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        cost: { amount: 0.125, currency: "USD" },
                        sessionUpdate: "usage_update",
                        size: 200_000,
                        used: 50_000,
                    },
                });
            }

            if (prompt === "interleave untagged progress") {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: {
                            text: "Checking the workspace",
                            type: "text",
                        },
                        messageId: `intermediate-${turnNumber.toString()}-1`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: {
                            text: "Preparing the next tool call",
                            type: "text",
                        },
                        messageId: `intermediate-${turnNumber.toString()}-2`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
            }

            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    kind: "read",
                    locations: [{ path: `${process.cwd()}/package.json` }],
                    name: "read_file",
                    rawInput: { path: "package.json" },
                    sessionUpdate: "tool_call",
                    status: "in_progress",
                    title: "Read package metadata",
                    toolCallId,
                },
            });
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content:
                        prompt === "exercise ACP controls"
                            ? [
                                  {
                                      newText: "const feature = true;\n",
                                      oldText: "const feature = false;\n",
                                      path: `${process.cwd()}/feature.ts`,
                                      type: "diff",
                                  },
                                  {
                                      content: {
                                          resource: {
                                              mimeType: "text/plain",
                                              text: "structured tool result",
                                              uri: "resource:///tool-result.txt",
                                          },
                                          type: "resource",
                                      },
                                      type: "content",
                                  },
                              ]
                            : prompt === "generate local image"
                              ? (() => {
                                    const path = join(tmpdir(), `mobius-fake-agent-${process.pid.toString()}.png`);
                                    writeFileSync(
                                        path,
                                        Buffer.from(
                                            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                            "base64",
                                        ),
                                    );
                                    return [
                                        {
                                            content: {
                                                data: "",
                                                mimeType: "image/png",
                                                type: "image",
                                                uri: path,
                                            },
                                            type: "content",
                                        },
                                    ];
                                })()
                              : prompt === "generate inline image"
                                ? [
                                      {
                                          content: {
                                              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                              mimeType: "image/png",
                                              type: "image",
                                          },
                                          type: "content",
                                      },
                                  ]
                                : undefined,
                    rawOutput: { name: "mobius-workspace" },
                    sessionUpdate: "tool_call_update",
                    status: "completed",
                    toolCallId,
                },
            });

            let selectedBranch = "";
            if (prompt === "exercise ACP controls") {
                const permission = await context.client.request(acp.methods.client.session.requestPermission, {
                    options: [
                        {
                            kind: "allow_once",
                            name: "Allow once",
                            optionId: "allow-once",
                        },
                        {
                            kind: "reject_once",
                            name: "Reject",
                            optionId: "reject",
                        },
                    ],
                    sessionId: context.params.sessionId,
                    toolCall: {
                        kind: "execute",
                        status: "pending",
                        title: "Run the verification command",
                        toolCallId: "permission-tool",
                    },
                });
                if (permission.outcome.outcome !== "selected") {
                    return { stopReason: "cancelled" };
                }

                const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
                    message: "Choose the branch to verify",
                    mode: "form",
                    requestedSchema: {
                        properties: {
                            branch: {
                                description: "Git branch name",
                                minLength: 1,
                                title: "Branch",
                                type: "string",
                            },
                        },
                        required: ["branch"],
                        type: "object",
                    },
                    sessionId: context.params.sessionId,
                });
                if (elicitation.action !== "accept") {
                    return { stopReason: "cancelled" };
                }
                const branch =
                    typeof elicitation.content === "object" &&
                    elicitation.content !== null &&
                    !Array.isArray(elicitation.content)
                        ? Reflect.get(elicitation.content, "branch")
                        : undefined;
                selectedBranch = typeof branch === "string" ? branch : "";

                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: {
                            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                            mimeType: "image/png",
                            type: "image",
                        },
                        messageId: `image-${turnNumber.toString()}`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
            }
            if (prompt === "exercise URL elicitation") {
                const elicitationId = `url-${turnNumber.toString()}`;
                const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
                    elicitationId,
                    message: "Connect the test account",
                    mode: "url",
                    sessionId: context.params.sessionId,
                    url: `https://example.com/connect/${elicitationId}`,
                });
                if (elicitation.action !== "accept") {
                    return { stopReason: "cancelled" };
                }
                await context.client.notify(acp.methods.client.elicitation.complete, {
                    elicitationId,
                });
            }
            if (prompt === "exercise Cursor extensions") {
                const question: unknown = await context.client.request("cursor/ask_question", {
                    questions: [
                        {
                            allowMultiple: false,
                            id: "mode",
                            options: [
                                { id: "agent", label: "Agent" },
                                { id: "plan", label: "Plan" },
                            ],
                            prompt: "Which mode should be used?",
                        },
                    ],
                    title: "Choose a mode",
                    toolCallId: "cursor-question",
                });
                const questionOutcome = isRecord(question) ? question["outcome"] : undefined;
                if (!isRecord(questionOutcome) || questionOutcome["outcome"] !== "skipped") {
                    throw new Error("Cursor question extension was not safely skipped");
                }
                const plan: unknown = await context.client.request("cursor/create_plan", {
                    name: "Verify Mobius",
                    plan: "Run the integration scenario",
                    todos: [
                        {
                            content: "Run the integration scenario",
                            id: "verify",
                            status: "pending",
                        },
                    ],
                    toolCallId: "cursor-plan",
                });
                const planOutcome = isRecord(plan) ? plan["outcome"] : undefined;
                if (!isRecord(planOutcome) || planOutcome["outcome"] !== "cancelled") {
                    throw new Error("Cursor plan extension was not safely cancelled");
                }
                await context.client.notify("cursor/update_todos", {
                    merge: false,
                    todos: [
                        {
                            content: "Run the integration scenario",
                            id: "verify",
                            status: "completed",
                        },
                    ],
                    toolCallId: "cursor-todos",
                });
                await context.client.notify("cursor/task", {
                    description: "Inspect the repository",
                    prompt: "Find the Agent catalog",
                    subagentType: "explore",
                    toolCallId: "cursor-task",
                });
                await context.client.notify("cursor/generate_image", {
                    description: "A generated test image",
                    toolCallId: "cursor-image",
                });
            }

            const responseText =
                prompt === "Report working directory"
                    ? process.cwd()
                    : prompt === "Report execution settings"
                      ? `${state.mode} ${state.model} ${state.reasoningEffort} ${state.fastMode ? "fast" : "standard"}`
                      : prompt === "Report prompt blocks"
                        ? `${countPromptBlock(context.params.prompt, "image").toString()} image, ${countPromptBlock(context.params.prompt, "resource").toString()} resource`
                        : prompt === "exercise ACP controls"
                          ? `${state.mode} ${state.model} ${state.reasoningEffort} ${state.fastMode ? "fast" : "standard"} ${selectedBranch} (${countPromptBlock(context.params.prompt, "image").toString()} image, ${countPromptBlock(context.params.prompt, "resource").toString()} resource)`
                          : agentName.length === 0
                            ? "Echo from ACP: "
                            : `${agentName} turn ${turnNumber.toString()}: `;
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        text: responseText,
                        type: "text",
                    },
                    messageId: `assistant-${turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            });
            const echoedPrompt =
                prompt === "generate markdown image" || prompt === "generate media artifacts"
                    ? (() => {
                          const path = join(
                              process.env["FAKE_ACP_IMAGE_DIRECTORY"] ?? process.cwd(),
                              "generated-image.png",
                          );
                          writeFileSync(
                              path,
                              Buffer.from(
                                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                  "base64",
                              ),
                          );
                          return `![Generated image](<${path}> "Generated locally")`;
                      })()
                    : prompt;
            if (prompt === "generate media artifacts") {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: {
                            resource: {
                                blob: "AAAAGGZ0eXBpc29tAAACAGlzb21pc28y",
                                mimeType: "video/mp4",
                                uri: "file:///generated-video.mp4",
                            },
                            type: "resource",
                        },
                        messageId: `assistant-${turnNumber.toString()}`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
            }
            if (
                prompt !== "exercise ACP controls" &&
                prompt !== "Report working directory" &&
                prompt !== "Report execution settings" &&
                prompt !== "Report prompt blocks"
            ) {
                const chunks =
                    prompt === "generate markdown image"
                        ? [echoedPrompt.slice(0, 2), echoedPrompt.slice(2, -1), echoedPrompt.slice(-1)]
                        : prompt === "stream token burst"
                          ? Array.from({ length: 64 }, (_value, index) => `token-${index.toString()} `)
                          : [echoedPrompt];
                for (const text of chunks) {
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: {
                            content: {
                                text,
                                type: "text",
                            },
                            messageId: `assistant-${turnNumber.toString()}`,
                            sessionUpdate: "agent_message_chunk",
                        },
                    });
                }
            }

            transcript.push({
                messageId: `assistant-${turnNumber.toString()}`,
                role: "assistant",
                text:
                    responseText +
                    (prompt === "exercise ACP controls" ||
                    prompt === "Report working directory" ||
                    prompt === "Report execution settings" ||
                    prompt === "Report prompt blocks"
                        ? ""
                        : echoedPrompt),
            });
            persistState(context.params.sessionId, state);

            return promptUsageResponse(prompt, turnNumber) ?? { stopReason: "end_turn" };
        } finally {
            turnCancellations.delete(context.params.sessionId);
            steeringWaiters.delete(context.params.sessionId);
        }
    })
    .onNotification(acp.methods.agent.session.cancel, (context) => {
        turnCancellations.get(context.params.sessionId)?.abort();
    })
    .onRequest(acp.methods.agent.session.close, (context) => {
        sessions.delete(context.params.sessionId);
        releaseWriter(context.params.sessionId);
        return {};
    })
    .connect(stream);
