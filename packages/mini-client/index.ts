#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { MobiusAppCredentialProvider, MobiusPlatformAppClient } from "@moxt-ai/mobius-sdk/platform";
import {
    MobiusClient,
    type MobiusLiveEventSubscription,
    type MobiusLiveSessionEventObserver,
    MobiusPageRequest,
    MobiusRecordingPolicy,
    MobiusRuntimePairingRequest,
    type MobiusSessionEvent,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    StaticMobiusCredentialProvider,
    WsTransport,
} from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import { optionalFlag, parseArguments, requireFlag, stateDirectory, validateFlags } from "./src/arguments.ts";
import { errorOutput, MiniClientError } from "./src/errors.ts";
import { runProcess } from "./src/process.ts";
import {
    type MiniClientSession,
    type MiniClientState,
    prepareStateDirectory,
    readState,
    replaceSession,
    requireFreshState,
    sessionFromState,
    writeState,
} from "./src/state.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const OPERATION_TIMEOUT_MILLISECONDS = 120_000;
const PAIRING_TIMEOUT_MILLISECONDS = 5 * 60_000;
const WORKSPACE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort(new Error("Interrupted")));
process.once("SIGTERM", () => shutdown.abort(new Error("Terminated")));

const pairSummarySchema = v.strictObject({
    app_id: v.string(),
    connection_id: v.string(),
    runtime_id: v.string(),
    status: v.picklist(["starting", "online", "reconnecting", "failed", "stopped"]),
    workspace: v.string(),
});
const pairListSchema = v.array(pairSummarySchema);

type PairSummary = v.InferOutput<typeof pairSummarySchema>;

function operationSignal(timeoutMilliseconds = OPERATION_TIMEOUT_MILLISECONDS): AbortSignal {
    return AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMilliseconds)]);
}

function identifier(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function endpoint(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch (cause) {
        throw new MiniClientError("invalid_endpoint", "The Platform endpoint is invalid", { cause });
    }
    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        parsed.search.length > 0 ||
        parsed.hash.length > 0
    ) {
        throw new MiniClientError("invalid_endpoint", "The Platform endpoint is invalid");
    }
    parsed.pathname = parsed.pathname.replace(/\/$/u, "");
    return parsed.toString().replace(/\/$/u, "");
}

interface ClientConnection {
    readonly close: () => void;
    readonly service: MobiusClient;
}

function client(state: MiniClientState, credential = state.appSecret): ClientConnection {
    const transport = new WsTransport();
    const service = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(credential),
        endpoint: state.endpoint,
        projectId: state.projectId,
        transport,
    });
    return {
        service,
        close: () => {
            service.close();
            transport.close();
        },
    };
}

async function sessionClient(state: MiniClientState, session: MiniClientSession): Promise<ClientConnection> {
    const authority = client(state);
    try {
        const access = await authority.service.sessions.createAccess(
            state.runtimeId,
            session.sessionId,
            900,
            operationSignal(),
        );
        return client(state, access.credential);
    } finally {
        authority.close();
    }
}

function output(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireOnline(state: MiniClientState): void {
    if (state.lifecycle !== "online") {
        throw new MiniClientError("runtime_stopped", "The local Runtime is stopped; run start first");
    }
}

function cliEnvironment(directory: string): NodeJS.ProcessEnv {
    return { ...process.env, MOBIUS_STATE_DIRECTORY: join(directory, "runtime") };
}

async function runMobiusCli(
    directory: string,
    arguments_: readonly string[],
    timeoutMilliseconds = OPERATION_TIMEOUT_MILLISECONDS,
): Promise<void> {
    await runProcess(
        "pnpm",
        ["--dir", WORKSPACE_ROOT, "mobius", ...arguments_],
        cliEnvironment(directory),
        operationSignal(timeoutMilliseconds),
    );
}

async function listCliPairs(directory: string): Promise<readonly PairSummary[]> {
    const path = join(directory, `.pairs-${randomUUID()}.json`);
    let file: FileHandle | undefined;
    try {
        file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await file.close();
        file = undefined;
        await runMobiusCli(directory, ["pair", "list", "--output-json", path]);
        const readable = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const decoded: unknown = JSON.parse(await readable.readFile("utf8"));
            return v.parse(pairListSchema, decoded);
        } finally {
            await readable.close();
        }
    } catch (cause) {
        throw new MiniClientError("invalid_cli_status", "The local Mobius CLI returned invalid status", { cause });
    } finally {
        await file?.close();
        await rm(path, { force: true });
    }
}

async function createCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set(["app-id", "app-secret", "endpoint", "workspace"]));
    await requireFreshState(directory);
    const appId = requireFlag(flags, "app-id");
    const appSecret = requireFlag(flags, "app-secret");
    const platformEndpoint = endpoint(optionalFlag(flags, "endpoint", DEFAULT_ENDPOINT));
    const workspace = optionalFlag(flags, "workspace", join(directory, "workspace"));
    await mkdir(workspace, { mode: 0o700, recursive: true });
    await mkdir(join(directory, "runtime"), { mode: 0o700, recursive: true });

    const platform = new MobiusPlatformAppClient({
        credentialProvider: new MobiusAppCredentialProvider(appSecret),
        endpoint: platformEndpoint,
    });
    const signal = operationSignal();
    const project = await platform.createProject(
        appId,
        {
            clientReference: identifier("client"),
            displayName: `Mini client ${new Date().toISOString()}`,
            idempotencyKey: identifier("project"),
            locationHint: "wnam",
        },
        signal,
    );
    const service = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(appSecret),
        endpoint: platformEndpoint,
        projectId: project.projectId,
    });
    try {
        const pairing = await service.runtimePairings.create(
            new MobiusRuntimePairingRequest(identifier("pairing")),
            signal,
        );
        await runMobiusCli(
            directory,
            [
                "pair",
                "--url",
                platformEndpoint,
                "--pairing",
                pairing.pairingId,
                "--code",
                pairing.pairingCode,
                "--workspace",
                workspace,
            ],
            PAIRING_TIMEOUT_MILLISECONDS,
        );
        const pairs = await listCliPairs(directory);
        const connected = pairs.find(
            (candidate) => candidate.app_id === appId && candidate.runtime_id === pairing.runtimeId,
        );
        if (connected === undefined || connected.status !== "online") {
            throw new MiniClientError("runtime_unavailable", "The paired local Runtime did not become online");
        }
        const state: MiniClientState = {
            appId,
            appSecret,
            connectionId: connected.connection_id,
            endpoint: platformEndpoint,
            lifecycle: "online",
            projectId: project.projectId,
            runtimeId: pairing.runtimeId,
            sessions: [],
            version: 1,
            workspace,
        };
        await writeState(directory, state);
        output({
            appId,
            connectionId: connected.connection_id,
            endpoint: platformEndpoint,
            projectId: project.projectId,
            runtimeId: pairing.runtimeId,
            status: connected.status,
            workspace,
        });
    } finally {
        service.close();
    }
}

async function statusCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set());
    const state = await readState(directory);
    const pair = (await listCliPairs(directory)).find((candidate) => candidate.connection_id === state.connectionId);
    const connection = client(state);
    const service = connection.service;
    try {
        const runtime = (await service.runtimes.list(operationSignal())).find(
            (candidate) => candidate.runtimeId === state.runtimeId,
        );
        output({
            connectionId: state.connectionId,
            persistedLifecycle: state.lifecycle,
            platformOnline: runtime?.online ?? false,
            runtimeId: state.runtimeId,
            status: pair?.status ?? "missing",
        });
    } finally {
        connection.close();
    }
}

async function transitionRuntime(
    directory: string,
    flags: ReadonlyMap<string, string>,
    transition: "start" | "stop",
): Promise<void> {
    validateFlags(flags, new Set());
    const state = await readState(directory);
    await runMobiusCli(
        directory,
        transition === "start"
            ? ["start", "--connection", state.connectionId]
            : ["pair", "stop", "--connection", state.connectionId],
        PAIRING_TIMEOUT_MILLISECONDS,
    );
    const lifecycle = transition === "start" ? "online" : "stopped";
    await writeState(directory, { ...state, lifecycle });
    output({ connectionId: state.connectionId, status: lifecycle });
}

async function runtimeCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set());
    const state = await readState(directory);
    requireOnline(state);
    const connection = client(state);
    const service = connection.service;
    try {
        output({ runtimes: await service.runtimes.list(operationSignal()) });
    } finally {
        connection.close();
    }
}

async function createSessionCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set(["agent", "session", "title"]));
    const state = await readState(directory);
    requireOnline(state);
    const connection = client(state);
    const service = connection.service;
    try {
        const runtime = (await service.runtimes.list(operationSignal())).find(
            (candidate) => candidate.runtimeId === state.runtimeId && candidate.online,
        );
        if (runtime === undefined) {
            throw new MiniClientError("runtime_unavailable", "The local Runtime is not online");
        }
        const requestedAgent = flags.get("agent");
        const agent =
            requestedAgent === undefined
                ? runtime.agents.length === 1
                    ? runtime.agents[0]
                    : undefined
                : runtime.agents.find((candidate) => candidate.id === requestedAgent);
        if (agent === undefined) {
            throw new MiniClientError(
                "agent_required",
                `Select one available Agent with --agent: ${runtime.agents.map((candidate) => candidate.id).join(", ")}`,
            );
        }
        const sessionId = optionalFlag(flags, "session", identifier("session"));
        const title = optionalFlag(flags, "title", "Mini-client Session");
        const ready = await service.sessions.create(
            {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 30 * 24 * 60 * 60 * 1_000, 1_000, 6_000_000),
                runtimeId: state.runtimeId,
                sessionId,
                title,
            },
            operationSignal(),
        );
        const session: MiniClientSession = {
            additionalDirectoryIds: [],
            agentId: agent.id,
            bindingId: RUNTIME_WORKSPACE_BINDING_ID,
            directoryId: ready.directoryId,
            sessionId,
            turns: [],
        };
        await writeState(directory, replaceSession(state, session));
        output({ agentId: agent.id, configOptions: ready.configOptions, sessionId, title });
    } finally {
        connection.close();
    }
}

async function listSessionsCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set());
    const state = await readState(directory);
    const connection = client(state);
    const service = connection.service;
    try {
        const sessions = [];
        let cursor = "";
        do {
            const page = await service.sessions.list(new MobiusPageRequest(100, cursor), operationSignal());
            sessions.push(...page.sessions);
            cursor = page.nextCursor;
        } while (cursor.length > 0);
        output({ sessions });
    } finally {
        connection.close();
    }
}

async function loadConfiguration(
    service: MobiusClient,
    runtimeId: string,
    session: MiniClientSession,
): Promise<readonly SessionConfigOption[]> {
    const ready = await service.sessions.load(
        runtimeId,
        session.sessionId,
        {
            additionalDirectoryIds: session.additionalDirectoryIds,
            agentId: session.agentId,
            directoryId: session.directoryId,
        },
        operationSignal(),
    );
    return ready.configOptions;
}

async function configurationCommand(
    directory: string,
    flags: ReadonlyMap<string, string>,
    update: boolean,
): Promise<void> {
    validateFlags(flags, update ? new Set(["session", "config-id", "value"]) : new Set(["session"]));
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const connection = client(state);
    const service = connection.service;
    try {
        let options = await loadConfiguration(service, state.runtimeId, session);
        if (update) {
            const configId = requireFlag(flags, "config-id");
            const value = requireFlag(flags, "value");
            const option = options.find((candidate) => candidate.id === configId);
            if (option === undefined) {
                throw new MiniClientError("configuration_not_found", "The Agent did not offer that configuration");
            }
            const booleanValue = option.type === "boolean" ? parseBoolean(value) : false;
            if (option.type === "select" && !option.values.some((candidate) => candidate.value === value)) {
                throw new MiniClientError("configuration_value_invalid", "The Agent did not offer that value");
            }
            const configured = await service.sessions.updateConfiguration(
                state.runtimeId,
                session.sessionId,
                {
                    additionalDirectoryIds: session.additionalDirectoryIds,
                    agentId: session.agentId,
                    booleanValue,
                    configId,
                    directoryId: session.directoryId,
                    value: option.type === "select" ? value : "",
                    valueType: option.type,
                },
                operationSignal(),
            );
            options = configured.configOptions;
        }
        output({ configOptions: options, sessionId: session.sessionId });
    } finally {
        connection.close();
    }
}

function parseBoolean(value: string): boolean {
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new MiniClientError("configuration_value_invalid", "A boolean configuration value must be true or false");
}

function selections(options: readonly SessionConfigOption[]): readonly SessionConfigurationSelection[] {
    return options.map((option) => ({
        booleanValue: option.booleanValue,
        configId: option.id,
        value: option.currentValue,
        valueType: option.type,
    }));
}

function targetTurnId(session: MiniClientSession): string {
    const turn = session.turns.at(-1);
    if (turn !== undefined) {
        return turn.turnId;
    }
    throw new MiniClientError("active_turn_not_found", "No locally submitted Turn is currently active");
}

async function promptCommand(
    directory: string,
    flags: ReadonlyMap<string, string>,
    disposition: "prompt" | "steer",
): Promise<void> {
    validateFlags(
        flags,
        disposition === "steer" ? new Set(["session", "prompt"]) : new Set(["session", "prompt", "disposition"]),
    );
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const authority = client(state);
    let execution: ClientConnection | undefined;
    try {
        const configuration = selections(await loadConfiguration(authority.service, state.runtimeId, session));
        execution = await sessionClient(state, session);
        const requestedDisposition =
            disposition === "steer" ? SessionPromptDisposition.Steer : optionalFlag(flags, "disposition", "reject");
        if (
            requestedDisposition !== SessionPromptDisposition.Reject &&
            requestedDisposition !== SessionPromptDisposition.Queue &&
            requestedDisposition !== SessionPromptDisposition.Steer
        ) {
            throw new MiniClientError("invalid_disposition", "Disposition must be reject, queue, or steer");
        }
        const targetCommandId = requestedDisposition === SessionPromptDisposition.Reject ? "" : targetTurnId(session);
        const prompt = requireFlag(flags, "prompt");
        const turn = await execution.service.turns.submit(
            session.sessionId,
            {
                additionalDirectoryIds: session.additionalDirectoryIds,
                content: prompt,
                disposition: requestedDisposition,
                idempotencyKey: identifier("turn"),
                images: [],
                resources: [],
                sessionConfigurations: configuration,
                targetCommandId,
            },
            operationSignal(),
        );
        const updated = { ...session, turns: [...session.turns, { prompt, turnId: turn.turnId }] };
        await writeState(directory, replaceSession(state, updated));
        output({ sessionId: session.sessionId, state: turn.state, turnId: turn.turnId });
    } finally {
        execution?.close();
        authority.close();
    }
}

async function cancelCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set(["session", "turn"]));
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const connection = await sessionClient(state, session);
    const service = connection.service;
    try {
        const turn = await service.turns.cancel(
            session.sessionId,
            requireFlag(flags, "turn"),
            { idempotencyKey: identifier("cancel") },
            operationSignal(),
        );
        output({ sessionId: session.sessionId, state: turn.state, turnId: turn.turnId });
    } finally {
        connection.close();
    }
}

async function nativeMessages(
    service: MobiusClient,
    session: MiniClientSession,
    signal: AbortSignal,
): Promise<unknown> {
    const pages = [];
    let cursor = "";
    do {
        const page = await service.sessions.querySessionNativeMessages(
            session.sessionId,
            {
                additionalDirectoryIds: session.additionalDirectoryIds,
                agentId: session.agentId,
                directoryId: session.directoryId,
            },
            new MobiusPageRequest(100, cursor),
            signal,
        );
        pages.push(page);
        cursor = page.nextCursor ?? "";
    } while (cursor.length > 0 && pages.length < 100);
    const unavailable = pages.find((page) => page.status === "unavailable");
    if (unavailable !== undefined) {
        return unavailable;
    }
    return {
        coveredCommandIds: pages.flatMap((page) => (page.status === "available" ? page.coveredCommandIds : [])),
        coveredMessageIds: pages.flatMap((page) => (page.status === "available" ? page.coveredMessageIds : [])),
        messages: pages.toReversed().flatMap((page) => (page.status === "available" ? page.messages : [])),
        nextCursor: cursor.length === 0 ? null : cursor,
        status: "available",
        truncated: pages.some((page) => page.status === "available" && page.truncated),
    };
}

function terminal(event: MobiusSessionEvent): boolean {
    return (
        (event.payload instanceof MobiusTurnCompletedEvent && event.payload.stopReason !== "steered") ||
        event.payload instanceof MobiusTurnFailedEvent
    );
}

function eventCommandId(event: MobiusSessionEvent): string | undefined {
    const commandId = Reflect.get(event.payload, "commandId");
    return typeof commandId === "string" ? commandId : undefined;
}

function snapshotContainsPrompt(snapshot: unknown, prompt: string): boolean {
    if (typeof snapshot !== "object" || snapshot === null || !("messages" in snapshot)) {
        return false;
    }
    const messages = Reflect.get(snapshot, "messages");
    return (
        Array.isArray(messages) &&
        messages.some(
            (message) =>
                typeof message === "object" &&
                message !== null &&
                Reflect.get(message, "role") === "user" &&
                Reflect.get(message, "text") === prompt,
        )
    );
}

async function waitForTerminalSnapshot(
    service: MobiusClient,
    session: MiniClientSession,
    event: MobiusSessionEvent,
    expectedPrompt: string | undefined,
    signal: AbortSignal,
): Promise<unknown> {
    const payload = event.payload;
    if (!(payload instanceof MobiusTurnCompletedEvent) && !(payload instanceof MobiusTurnFailedEvent)) {
        return await nativeMessages(service, session, signal);
    }
    let snapshot = await nativeMessages(service, session, signal);
    if (expectedPrompt === undefined) {
        return snapshot;
    }
    for (let attempt = 0; attempt < 20 && !snapshotContainsPrompt(snapshot, expectedPrompt); attempt += 1) {
        await new Promise<void>((resolve, reject) => {
            const complete = (): void => {
                signal.removeEventListener("abort", abort);
                resolve();
            };
            const timeout = globalThis.setTimeout(complete, 100);
            const abort = (): void => {
                globalThis.clearTimeout(timeout);
                signal.removeEventListener("abort", abort);
                reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        snapshot = await nativeMessages(service, session, signal);
    }
    return snapshot;
}

async function getCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    validateFlags(flags, new Set(["session", "follow"]));
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const follow = flags.get("follow") === "true";
    const connection = await sessionClient(state, session);
    const service = connection.service;
    const signal = shutdown.signal;
    let snapshot: unknown;
    let subscription: MobiusLiveEventSubscription | undefined;
    const prompts = new Map(session.turns.map((turn) => [turn.turnId, turn.prompt]));
    const observer: MobiusLiveSessionEventObserver = {
        reconcile: async (connection) => {
            snapshot = await nativeMessages(service, session, signal);
            if (follow) {
                output({ connection: connection.kind, sessionId: session.sessionId, snapshot });
            }
        },
        receive: async (event) => {
            if (event.payload instanceof MobiusTurnStartedEvent) {
                prompts.set(event.payload.commandId, event.payload.prompt);
            }
            const isTerminal = terminal(event);
            const commandId = eventCommandId(event);
            const expectedPrompt = commandId === undefined ? undefined : prompts.get(commandId);
            snapshot = isTerminal
                ? await waitForTerminalSnapshot(service, session, event, expectedPrompt, signal)
                : await nativeMessages(service, session, signal);
            if (follow) {
                output({ event, sessionId: session.sessionId, snapshot });
            }
            return !isTerminal;
        },
    };
    try {
        subscription = await service.events.subscribeLive(session.sessionId, observer, signal);
        if (!follow) {
            subscription.close();
            await subscription.completed;
            output({ sessionId: session.sessionId, snapshot });
            return;
        }
        await subscription.completed;
    } finally {
        subscription?.close();
        connection.close();
    }
}

function help(): void {
    process.stdout.write(
        `Mobius mini-client\n\nUsage:\n  pnpm exec tsx ./index.ts --state-dir=<dir> <command> [options]\n\nCommands:\n  create, status, start, stop, list-runtimes, list-sessions, create-session\n  get-agent-configuration, update-agent-configuration\n  send-prompt, steer, cancel-turn, get\n`,
    );
}

async function main(): Promise<void> {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.command.length === 0 || parsed.command === "help" || parsed.flags.has("help")) {
        help();
        return;
    }
    const directory = stateDirectory(parsed.flags);
    await prepareStateDirectory(directory);
    switch (parsed.command) {
        case "create":
            await createCommand(directory, parsed.flags);
            break;
        case "status":
            await statusCommand(directory, parsed.flags);
            break;
        case "start":
        case "stop":
            await transitionRuntime(directory, parsed.flags, parsed.command);
            break;
        case "list-runtimes":
            await runtimeCommand(directory, parsed.flags);
            break;
        case "list-sessions":
            await listSessionsCommand(directory, parsed.flags);
            break;
        case "create-session":
            await createSessionCommand(directory, parsed.flags);
            break;
        case "get-agent-configuration":
            await configurationCommand(directory, parsed.flags, false);
            break;
        case "update-agent-configuration":
            await configurationCommand(directory, parsed.flags, true);
            break;
        case "send-prompt":
            await promptCommand(directory, parsed.flags, "prompt");
            break;
        case "steer":
            await promptCommand(directory, parsed.flags, "steer");
            break;
        case "cancel-turn":
            await cancelCommand(directory, parsed.flags);
            break;
        case "get":
            await getCommand(directory, parsed.flags);
            break;
        default:
            throw new MiniClientError("unknown_command", `Unknown command: ${parsed.command}`);
    }
}

try {
    await main();
} catch (cause) {
    process.stderr.write(`${JSON.stringify(errorOutput(cause))}\n`);
    process.exitCode = shutdown.signal.aborted ? 130 : 1;
}
