#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MobiusAppCredentialProvider, MobiusPlatformAppClient } from "@moxt-ai/mobius-sdk/platform";
import {
    type NativeSessionEvents,
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionCommand,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    type SessionEvent,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import {
    MobiusClient,
    type MobiusLiveEventSubscription,
    MobiusPageRequest,
    MobiusRuntimePairingRequest,
    type MobiusSessionEventObserver,
    MobiusSessionImportBinding,
    StaticMobiusCredentialProvider,
    WsTransport,
} from "@moxt-ai/mobius-sdk/server";
import { Command, CommanderError } from "commander";
import * as v from "valibot";
import { optionalFlag, requireFlag, stateDirectory } from "./src/arguments.ts";
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
    status: v.picklist(["active", "stopped"]),
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

async function waitForRuntimeOnline(service: MobiusClient, runtimeId: string): Promise<void> {
    const deadline = AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS);
    const signal = AbortSignal.any([shutdown.signal, deadline]);
    try {
        while (true) {
            const runtime = (await service.runtimes.list(signal)).find(
                (candidate) => candidate.runtimeId === runtimeId,
            );
            if (runtime?.online === true) {
                return;
            }
            await setTimeout(100, undefined, { signal });
        }
    } catch (cause) {
        shutdown.signal.throwIfAborted();
        if (deadline.aborted) {
            throw new MiniClientError("runtime_unavailable", "The paired local Runtime did not become online", {
                cause,
            });
        }
        throw cause;
    }
}

async function createCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
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
        if (connected === undefined || connected.status !== "active") {
            throw new MiniClientError("runtime_unavailable", "The paired local Runtime did not become online");
        }
        await waitForRuntimeOnline(service, pairing.runtimeId);
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
            stateDir: directory,
            status: connected.status,
            workspace,
        });
    } finally {
        service.close();
    }
}

async function statusCommand(directory: string): Promise<void> {
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

async function transitionRuntime(directory: string, transition: "start" | "stop"): Promise<void> {
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

async function runtimeCommand(directory: string): Promise<void> {
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

async function allEvents(service: MobiusClient, sessionId: string): Promise<readonly SessionEvent[]> {
    let cursor = "";
    let events: readonly SessionEvent[] = [];
    do {
        const page = await service.events.list(sessionId, new MobiusPageRequest(100, cursor), operationSignal());
        events = [...page.events, ...events];
        cursor = page.nextCursor ?? "";
    } while (cursor.length > 0);
    return events;
}

function copiedSessionBinding(state: MiniClientState, source: MiniClientSession): MobiusSessionImportBinding {
    return new MobiusSessionImportBinding(identifier("binding"), state.runtimeId, source.agentId, source.directoryId);
}

async function copyEventLogCommand(
    directory: string,
    flags: ReadonlyMap<string, string>,
    operation: "import" | "fork",
): Promise<void> {
    const state = await readState(directory);
    requireOnline(state);
    const source = sessionFromState(state, requireFlag(flags, "session"));
    const connection = client(state);
    try {
        const service = connection.service;
        const sourceEvents = await allEvents(service, source.sessionId);
        const throughEventId =
            operation === "fork" ? requireFlag(flags, "through-event") : sourceEvents.at(-1)?.eventId;
        if (throughEventId === undefined) {
            throw new MiniClientError("event_log_empty", "The source V2 Session event log is empty");
        }
        const target =
            operation === "import"
                ? await service.sessions.import(
                      await service.sessions.export(source.sessionId, operationSignal()),
                      copiedSessionBinding(state, source),
                      operationSignal(),
                  )
                : await service.sessions.forkRecorded(
                      source.sessionId,
                      { targetBinding: copiedSessionBinding(state, source), throughEventId },
                      operationSignal(),
                  );
        const boundary = sourceEvents.findIndex((event) => event.eventId === throughEventId);
        if (boundary === -1) {
            throw new MiniClientError("event_not_found", "The selected V2 fork boundary is unavailable");
        }
        const expected = operation === "import" ? sourceEvents : sourceEvents.slice(0, boundary + 1);
        const copied = await allEvents(service, target.sessionId);
        const matches =
            copied.length === expected.length &&
            copied.every(
                (event, index) =>
                    JSON.stringify(event.payload) === JSON.stringify(expected[index]?.payload) &&
                    event.sessionId === target.sessionId &&
                    event.eventId !== expected[index]?.eventId,
            );
        if (!matches) {
            throw new MiniClientError("event_log_mismatch", "The copied V2 event log does not match its source");
        }
        await writeState(directory, replaceSession(state, { ...source, sessionId: target.sessionId, turns: [] }));
        output({ count: copied.length, operation, sessionId: target.sessionId, verified: true });
    } finally {
        connection.close();
    }
}

async function createSessionCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
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

async function listSessionsCommand(directory: string): Promise<void> {
    const state = await readState(directory);
    const connection = client(state);
    const service = connection.service;
    try {
        output({ sessions: await service.runtimes.listSessions(state.runtimeId, 500, operationSignal()) });
    } finally {
        connection.close();
    }
}

async function loadSession(service: MobiusClient, runtimeId: string, session: MiniClientSession) {
    return await service.sessions.load(
        runtimeId,
        session.sessionId,
        {
            additionalDirectoryIds: session.additionalDirectoryIds,
            agentId: session.agentId,
            directoryId: session.directoryId,
        },
        operationSignal(),
    );
}

async function configurationCommand(
    directory: string,
    flags: ReadonlyMap<string, string>,
    update: boolean,
): Promise<void> {
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const connection = client(state);
    const service = connection.service;
    try {
        let options = (await loadSession(service, state.runtimeId, session)).configOptions;
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
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const authority = client(state);
    let execution: ClientConnection | undefined;
    try {
        const configuration = selections(
            (await loadSession(authority.service, state.runtimeId, session)).configOptions,
        );
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
                attachments: [],
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

async function compactCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const authority = client(state);
    let execution: ClientConnection | undefined;
    try {
        execution = await sessionClient(state, session);
        const discoverySignal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(5_000)]);
        let advertisedCommands: readonly SessionCommand[] = [];
        let subscription: MobiusLiveEventSubscription | undefined;
        const observer: MobiusSessionEventObserver = {
            reconcile: () => Promise.resolve(),
            receive: (events) => {
                for (const event of events) {
                    if (event.type === "acp" && event.payload.sessionUpdate === "available_commands_update") {
                        advertisedCommands = event.payload.availableCommands.map((command) => ({
                            description: command.description,
                            inputHint: command.input?.hint ?? "",
                            name: command.name,
                        }));
                    }
                }
                return Promise.resolve(
                    !advertisedCommands.some((candidate) => candidate.name.toLowerCase() === "compact"),
                );
            },
        };
        try {
            subscription = await execution.service.events.subscribeLive(session.sessionId, observer, discoverySignal);
            const ready = await loadSession(authority.service, state.runtimeId, session);
            let commands = ready.commands;
            if (!commands.some((candidate) => candidate.name.toLowerCase() === "compact")) {
                await subscription.completed;
                commands = advertisedCommands;
            }
            const command = commands.find((candidate) => candidate.name.toLowerCase() === "compact");
            if (command === undefined) {
                throw new MiniClientError(
                    "compact_unavailable",
                    "The selected Agent does not provide context compaction",
                );
            }
            const prompt = `/${command.name}`;
            const turn = await execution.service.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: session.additionalDirectoryIds,
                    content: prompt,
                    disposition: SessionPromptDisposition.Reject,
                    idempotencyKey: identifier("compact"),
                    attachments: [],
                    sessionConfigurations: selections(ready.configOptions),
                    targetCommandId: "",
                },
                operationSignal(),
            );
            const updated = { ...session, turns: [...session.turns, { prompt, turnId: turn.turnId }] };
            await writeState(directory, replaceSession(state, updated));
            output({ command: command.name, sessionId: session.sessionId, state: turn.state, turnId: turn.turnId });
        } catch (cause) {
            shutdown.signal.throwIfAborted();
            if (!discoverySignal.aborted) {
                throw cause;
            }
            throw new MiniClientError("compact_unavailable", "The selected Agent does not provide context compaction", {
                cause,
            });
        } finally {
            subscription?.close();
        }
    } finally {
        execution?.close();
        authority.close();
    }
}

async function cancelCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
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

async function sessionEvents(
    service: MobiusClient,
    session: MiniClientSession,
    signal: AbortSignal,
): Promise<NativeSessionEvents> {
    const pages: NativeSessionEvents[] = [];
    let cursor: string | null = null;
    do {
        const page = await service.events.list(session.sessionId, new MobiusPageRequest(50, cursor ?? ""), signal);
        pages.push({ events: page, queuedPromptRequests: [] });
        cursor = page.nextCursor;
    } while (cursor !== null && pages.length < 100);
    const newest = pages[0];
    if (newest === undefined) {
        throw new MiniClientError("event_log_unavailable", "The Runtime returned no V2 event-log page");
    }
    const events = pages.toReversed().flatMap((page) => page.events.events);
    if (pages.some((page) => page.events.sessionGenerationId !== newest.events.sessionGenerationId)) {
        throw new MiniClientError("event_log_generation_changed", "The Session reloaded while history was loading");
    }
    return {
        events: {
            events,
            nextCursor: cursor,
            sessionGenerationId: newest.events.sessionGenerationId,
            tailCursor: events.at(-1)?.eventId ?? "",
            truncated: cursor !== null,
            version: 2,
        },
        queuedPromptRequests: newest.queuedPromptRequests,
    };
}

async function getCommand(directory: string, flags: ReadonlyMap<string, string>): Promise<void> {
    const state = await readState(directory);
    requireOnline(state);
    const session = sessionFromState(state, requireFlag(flags, "session"));
    const follow = flags.get("follow") === "true";
    const connection = await sessionClient(state, session);
    const service = connection.service;
    const signal = shutdown.signal;
    let subscription: MobiusLiveEventSubscription | undefined;
    try {
        if (!follow) {
            output({ events: await sessionEvents(service, session, signal), sessionId: session.sessionId });
            return;
        }
        const seen = new Set<string>();
        const followedCommandId = session.turns.at(-1)?.turnId;
        const terminal = Promise.withResolvers<void>();
        const isFollowedTerminal = (event: SessionLiveEvent): boolean =>
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "prompt.completed" ||
                event.payload.kind === "prompt.failed" ||
                event.payload.kind === "prompt.failed-before-start") &&
            event.payload.commandId === followedCommandId;
        const observer: MobiusSessionEventObserver = {
            reconcile: async (liveConnection) => {
                const events = await sessionEvents(service, session, signal);
                for (const event of events.events.events) {
                    seen.add(event.eventId);
                }
                output({ connection: liveConnection.kind, events, sessionId: session.sessionId });
                if (followedCommandId !== undefined) {
                    const execution = await service.sessions.readSessionExecution(
                        session.sessionId,
                        session,
                        operationSignal(),
                        followedCommandId,
                    );
                    output({ execution, sessionId: session.sessionId });
                    if (execution.command?.state === "completed" || execution.command?.state === "failed") {
                        terminal.resolve();
                    }
                }
            },
            receive: async (events) => {
                const unseen = events.filter((event) => !seen.has(event.eventId));
                for (const event of unseen) {
                    seen.add(event.eventId);
                }
                if (unseen.length > 0) {
                    output({ events: unseen, sessionId: session.sessionId });
                }
                if (unseen.some(isFollowedTerminal)) {
                    terminal.resolve();
                    return false;
                }
                return true;
            },
        };
        subscription = await service.events.subscribeLive(session.sessionId, observer, signal);
        await Promise.race([subscription.completed, terminal.promise]);
    } finally {
        subscription?.close();
        connection.close();
    }
}

type MiniClientCommand =
    | "cancel-turn"
    | "compact"
    | "create"
    | "create-session"
    | "get"
    | "get-agent-configuration"
    | "import-event-log"
    | "list-runtimes"
    | "list-sessions"
    | "fork-event-log"
    | "send-prompt"
    | "start"
    | "status"
    | "steer"
    | "stop"
    | "update-agent-configuration";

function commandFlags(command: Command): ReadonlyMap<string, string> {
    const flags = new Map<string, string>();
    for (const option of command.options) {
        const name = option.long?.slice(2);
        const value: unknown = command.getOptionValue(option.attributeName());
        if (name === undefined || value === undefined || value === false) {
            continue;
        }
        if (typeof value === "string") {
            flags.set(name, value);
        } else if (value === true) {
            flags.set(name, "true");
        } else {
            throw new MiniClientError("invalid_arguments", `Option --${name} has an invalid value`);
        }
    }
    return flags;
}

async function runCommand(program: Command, command: Command, name: MiniClientCommand): Promise<void> {
    const selectedDirectory = stateDirectory(program.getOptionValue("stateDir"), name);
    const directory = selectedDirectory.path;
    if (selectedDirectory.kind === "generated") {
        process.stderr.write(`Mini-client state directory: ${directory}\n`);
    }
    await prepareStateDirectory(directory);
    const flags = commandFlags(command);
    switch (name) {
        case "create":
            await createCommand(directory, flags);
            break;
        case "status":
            await statusCommand(directory);
            break;
        case "start":
        case "stop":
            await transitionRuntime(directory, name);
            break;
        case "list-runtimes":
            await runtimeCommand(directory);
            break;
        case "list-sessions":
            await listSessionsCommand(directory);
            break;
        case "create-session":
            await createSessionCommand(directory, flags);
            break;
        case "get-agent-configuration":
            await configurationCommand(directory, flags, false);
            break;
        case "update-agent-configuration":
            await configurationCommand(directory, flags, true);
            break;
        case "send-prompt":
            await promptCommand(directory, flags, "prompt");
            break;
        case "compact":
            await compactCommand(directory, flags);
            break;
        case "steer":
            await promptCommand(directory, flags, "steer");
            break;
        case "cancel-turn":
            await cancelCommand(directory, flags);
            break;
        case "get":
            await getCommand(directory, flags);
            break;
        case "import-event-log":
            await copyEventLogCommand(directory, flags, "import");
            break;
        case "fork-event-log":
            await copyEventLogCommand(directory, flags, "fork");
            break;
    }
}

function createProgram(): Command {
    const program = new Command()
        .name("mobius-mini-client")
        .description("Drive a Mobius Platform and local Runtime without Mobius Chat.")
        .option("--state-dir <directory>", "persistent mini-client state directory")
        .showHelpAfterError()
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
    program.action(() => program.outputHelp());

    const add = (name: MiniClientCommand, description: string): Command => {
        const command = program.command(name).description(description);
        command.action(async () => runCommand(program, command, name));
        return command;
    };

    add("create", "create a Project and pair an isolated Runtime")
        .option("--app-id <id>", "Platform application identifier")
        .option("--app-secret <secret>", "Platform application credential")
        .option("--endpoint <url>", "Platform endpoint")
        .option("--workspace <directory>", "Runtime workspace directory");
    add("status", "show the isolated Runtime status");
    add("start", "start the isolated Runtime");
    add("stop", "stop the isolated Runtime");
    add("list-runtimes", "list Platform Runtimes");
    add("list-sessions", "list Runtime Sessions");
    add("create-session", "create an Agent Session")
        .option("--agent <id>", "Agent identifier")
        .option("--session <id>", "Session identifier")
        .option("--title <title>", "Session title");
    add("get-agent-configuration", "show Agent configuration").option("--session <id>", "Session identifier");
    add("update-agent-configuration", "update Agent configuration")
        .option("--session <id>", "Session identifier")
        .option("--config-id <id>", "configuration identifier")
        .option("--value <value>", "configuration value");
    add("send-prompt", "submit a prompt")
        .option("--session <id>", "Session identifier")
        .option("--prompt <text>", "prompt text")
        .option("--disposition <mode>", "reject or queue while another turn is active");
    add("compact", "compact the Session context").option("--session <id>", "Session identifier");
    add("steer", "steer an active turn")
        .option("--session <id>", "Session identifier")
        .option("--prompt <text>", "steering prompt text");
    add("cancel-turn", "cancel a turn")
        .option("--session <id>", "Session identifier")
        .option("--turn <id>", "turn identifier");
    add("get", "get raw V2 Session events and optionally follow updates")
        .option("--session <id>", "Session identifier")
        .option("--follow", "follow Session updates");
    add("import-event-log", "import and verify a V2 Session event log").option(
        "--session <id>",
        "source Session identifier",
    );
    add("fork-event-log", "fork and verify a V2 Session event-log prefix")
        .option("--session <id>", "source Session identifier")
        .option("--through-event <id>", "inclusive source event identifier");
    return program;
}

async function main(): Promise<void> {
    await createProgram().parseAsync(process.argv);
}

try {
    await main();
} catch (cause) {
    if (cause instanceof CommanderError && cause.exitCode === 0) {
        process.exitCode = 0;
    } else {
        const error =
            cause instanceof CommanderError
                ? new MiniClientError("invalid_arguments", cause.message, { cause })
                : cause;
        process.stderr.write(`${JSON.stringify(errorOutput(error))}\n`);
        process.exitCode = shutdown.signal.aborted ? 130 : 1;
    }
}
