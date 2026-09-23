import { spawn } from "node:child_process";

import {
    type ClientConnection,
    type CompleteElicitationNotification,
    type ContentBlock,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    type ElicitationContentValue,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    RequestError,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
    AGENT_CONTENT_KIND,
    type AgentContentEvent,
    type AgentDisplayContent,
    type AgentPromptResponse,
    decodeAgentPromptResponse,
    type NativeSessionHistory,
    type PromptImage,
    type PromptResource,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionCapabilities,
    type SessionCommand,
    type SessionCommandsUpdatedEvent,
    type SessionConfigOption,
    type SessionConfigUpdatedEvent,
    type SessionElicitationField,
    type SessionElicitationOption,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionPermissionOption,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import type { LocalRasterImage } from "../authorization/local-raster.ts";
import { readInlineRaster, readLocalRaster } from "../authorization/local-raster.ts";
import { type LocalVideo, readInlineVideo } from "../authorization/local-video.ts";
import type { AcpAgentDefinition } from "../config.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../infra/operation-metrics.ts";
import { embedLocalHistoryImages } from "../native-sessions/history-images.ts";
import {
    captureProcessTree,
    type ProcessTreeIdentity,
    revalidateExecutable,
    stopProcessTree,
} from "../process/executable.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";
import {
    type AcpActivity,
    type AcpActivityNarration,
    AcpActivityTracker,
    imageDisplayContent,
    isProgressMessage,
    normalizeContentBlock,
} from "./activity.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";
import {
    type AcpEndpointTermination,
    acpEndpointTerminationError,
    type InProcessAcpEndpoint,
} from "./in-process/acp-endpoint.ts";
import { emitMarkdownChunksWithLocalImages } from "./markdown-images.ts";
import {
    type NativeSessionOrigin,
    type NativeSessionPage,
    nativeSessionIdSchema,
    nativeSessionPageSchema,
} from "./native-session.ts";
import { normalizeAcpCapabilities, unsupportedSessionCapabilities } from "./session-capabilities.ts";
import { type SessionConfigProtocol, SessionConfigProtocolError } from "./session-config/session-config-protocol.ts";
import { sessionConfigProtocolForAgent } from "./session-config/session-config-registry.ts";
import { AcpHistoryReplay } from "./session-history.ts";
import {
    type AcpSessionStore,
    AcpStoredSession,
    DeletedAcpStoredSession,
    FoundAcpStoredSession,
    MemoryAcpSessionStore,
} from "./session-store.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;
const MAX_ACP_PROCESSES = 10;
const MAX_PRE_SESSION_UPDATES = 100;
const MAX_PRE_SESSION_UPDATE_BYTES = 1024 * 1024;
const SESSION_CONTROL_COMMAND_ID = "session-control";
const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;

function nativeHistoryNotRetained(): NativeSessionHistory {
    return {
        cause: {
            code: "native_history_not_retained",
            message: "Native message history is not retained in the cloud for this Session.",
        },
        status: "unavailable",
    };
}

export interface AcpPrepareOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly origin?: NativeSessionOrigin;
}

export interface AcpNativeHistoryReader {
    readonly read: (options: AcpPrepareOptions, nativeSessionId: string) => Promise<NativeSessionHistory | null>;
}

export interface AcpAgentSettingsInspectionOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export interface AcpConfigureOptions extends AcpPrepareOptions {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly requestId: string;
    readonly value: string;
    readonly valueType: SessionConfigOption["type"];
}

interface AcpPromptContentOptions {
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
}

export interface AcpTurnOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly commandId: string;
    readonly disposition?: string;
    readonly onActivity: (activity: AcpActivity) => Promise<void>;
    /**
     * Receives streamed narration increments. Optional: without a sink the same text
     * still arrives once on the completed activity snapshot, just without live updates.
     */
    readonly onNarration?: (narration: AcpActivityNarration) => Promise<void>;
    readonly onText: (text: string, messageId: string) => Promise<void>;
    readonly targetCommandId?: string;
}

export interface AcpSteerOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly commandId: string;
    readonly targetCommandId: string;
}

export interface AcpSessionForkPoint {
    readonly messageFingerprint: string;
    readonly messageId: string;
    readonly messageOccurrence: number;
}

export interface AcpPermissionResponseOptions {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: SessionPermissionResolvedEvent["outcome"];
    readonly sessionId: string;
}

export interface AcpElicitationResponseOptions {
    readonly action: SessionElicitationResolvedEvent["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}

export type AcpPromptResult = AgentPromptResponse;

export interface AcpSessionObserver {
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onContent: (event: AgentContentEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
    readonly onUsage: (event: SessionUsageUpdatedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onContent = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
    readonly onUsage = (): Promise<void> => Promise.resolve();
}

export class AcpPreparedSession {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly restored: boolean;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        restored: boolean,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.restored = restored;
    }
}

export class AcpAgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];

    constructor(agentName: string, agentVersion: string, configOptions: readonly SessionConfigOption[]) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
    }
}

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";

class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

class AcpProcessCapacityLease {
    readonly #releaseCapacity: () => void;
    #released = false;

    constructor(releaseCapacity: () => void) {
        this.#releaseCapacity = releaseCapacity;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#releaseCapacity();
    };
}

class AcpProcessCapacityWaiter {
    readonly completion = Promise.withResolvers<AcpProcessCapacityLease>();
    readonly signal: AbortSignal;

    constructor(signal: AbortSignal) {
        this.signal = signal;
    }

    readonly cancel = (): void => {
        try {
            this.signal.throwIfAborted();
        } catch (error) {
            this.completion.reject(error);
        }
    };
}

class AcpProcessCapacityLock {
    #locked = false;
    readonly #waiters: AcpProcessCapacityWaiter[] = [];

    readonly acquire = async (signal: AbortSignal): Promise<AcpProcessCapacityLease> => {
        signal.throwIfAborted();
        if (!this.#locked) {
            this.#locked = true;
            return new AcpProcessCapacityLease(this.#release);
        }

        const waiter = new AcpProcessCapacityWaiter(signal);
        this.#waiters.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        if (signal.aborted) {
            waiter.cancel();
        }
        try {
            return await waiter.completion.promise;
        } finally {
            signal.removeEventListener("abort", waiter.cancel);
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) {
                this.#waiters.splice(index, 1);
            }
        }
    };

    readonly #release = (): void => {
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            if (waiter === undefined || waiter.signal.aborted) {
                continue;
            }
            waiter.completion.resolve(new AcpProcessCapacityLease(this.#release));
            return;
        }
        this.#locked = false;
    };
}

async function waitForAcpProcessCapacity(completion: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<void>();
    const cancel = (): void => {
        try {
            signal.throwIfAborted();
        } catch (error) {
            cancelled.reject(error);
        }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
        cancel();
    }
    try {
        await Promise.race([completion, cancelled.promise]);
    } finally {
        signal.removeEventListener("abort", cancel);
    }
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
                controller.error(new Error("ACP process produced a non-binary chunk"));
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

export function createWritableAcpStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    let outputFailure: unknown;
    const pendingWriteFailures = new Set<(error: unknown) => void>();
    const fail = (error: unknown): void => {
        outputFailure = error;
        for (const reject of pendingWriteFailures) {
            reject(error);
        }
        pendingWriteFailures.clear();
    };
    output.on("error", fail);
    output.once("close", () => {
        if (outputFailure === undefined) {
            fail(new Error("ACP process input closed"));
        }
    });
    return new WritableStream<Uint8Array>({
        write(chunk) {
            if (outputFailure !== undefined) {
                return Promise.reject(outputFailure);
            }
            return new Promise<void>((resolve, reject) => {
                pendingWriteFailures.add(reject);
                output.write(chunk, (error) => {
                    pendingWriteFailures.delete(reject);
                    if (error) {
                        outputFailure = error;
                        reject(error);
                        return;
                    }
                    if (outputFailure !== undefined) {
                        reject(outputFailure);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}

function truncate(value: string, maximumLength: number): string {
    return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length && leftEntries.every(([name, value]) => right[name] === value);
}

function elicitationFieldType(value: unknown): SessionElicitationField["type"] {
    if (value === "boolean") {
        return "boolean";
    }
    if (value === "integer") {
        return "integer";
    }
    if (value === "number") {
        return "number";
    }
    if (value === "array") {
        return "multiselect";
    }
    return "string";
}

function normalizeElicitationOptions(schema: Readonly<Record<string, unknown>>): readonly SessionElicitationOption[] {
    const normalized: SessionElicitationOption[] = [];
    const oneOf = schema["oneOf"];
    if (Array.isArray(oneOf)) {
        for (const option of oneOf) {
            if (isRecord(option) && typeof option["const"] === "string") {
                normalized.push({
                    description: truncate(readString(option["description"]), 500),
                    label: truncate(readString(option["title"], option["const"]), 255),
                    value: truncate(option["const"], 500),
                });
            }
        }
        return normalized.slice(0, 200);
    }
    const enumValues = schema["enum"];
    if (Array.isArray(enumValues)) {
        for (const entry of enumValues) {
            if (typeof entry === "string") {
                normalized.push({ description: "", label: entry, value: entry });
            }
        }
        return normalized.slice(0, 200);
    }
    const items = schema["items"];
    if (!isRecord(items)) {
        return normalized;
    }
    const anyOf = items["anyOf"];
    if (Array.isArray(anyOf)) {
        return normalizeElicitationOptions({ oneOf: anyOf });
    }
    return normalizeElicitationOptions({ enum: items["enum"] });
}

function numericString(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value) ? value.toString() : "";
}

function normalizeElicitationFields(requestedSchema: unknown): readonly SessionElicitationField[] {
    if (!isRecord(requestedSchema) || !isRecord(requestedSchema["properties"])) {
        return [];
    }
    const properties = requestedSchema["properties"];
    const requiredValues = requestedSchema["required"];
    const required = new Set<string>(
        Array.isArray(requiredValues) ? requiredValues.filter((entry) => typeof entry === "string") : [],
    );
    const normalized: SessionElicitationField[] = [];
    for (const [name, property] of Object.entries(properties)) {
        if (!isRecord(property)) {
            continue;
        }
        const type = elicitationFieldType(property["type"]);
        const options = normalizeElicitationOptions(property);
        const normalizedType = type === "string" && options.length > 0 ? "select" : type;
        const defaultValue = property["default"];
        normalized.push({
            defaultBooleanValue: typeof defaultValue === "boolean" ? defaultValue : false,
            defaultNumberValue: typeof defaultValue === "number" && Number.isFinite(defaultValue) ? defaultValue : 0,
            defaultStringValue:
                typeof defaultValue === "string"
                    ? truncate(defaultValue, 10_000)
                    : Array.isArray(defaultValue)
                      ? truncate(JSON.stringify(defaultValue), 10_000)
                      : "",
            description: truncate(readString(property["description"]), 500),
            format: truncate(readString(property["format"]), 64),
            hasDefaultValue: defaultValue !== undefined && defaultValue !== null,
            maximum: numericString(property["maximum"]),
            maximumLength: numericString(property["maxLength"] ?? property["maxItems"]),
            minimum: numericString(property["minimum"]),
            minimumLength: numericString(property["minLength"] ?? property["minItems"]),
            name: truncate(name, 128),
            options,
            pattern: truncate(readString(property["pattern"]), 500),
            required: required.has(name),
            title: truncate(readString(property["title"], name), 255),
            type: normalizedType,
        });
    }
    return normalized.slice(0, 100);
}

function validateStringValue(name: string, value: string, schema: Readonly<Record<string, unknown>>): void {
    const minimum = schema["minLength"];
    const maximum = schema["maxLength"];
    if (typeof minimum === "number" && value.length < minimum) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is shorter than allowed`,
            {},
            "invalid_elicitation_response",
        );
    }
    if (typeof maximum === "number" && value.length > maximum) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is longer than allowed`,
            {},
            "invalid_elicitation_response",
        );
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} does not match the required format`,
            {},
            "invalid_elicitation_response",
        );
    }
    const allowed = normalizeElicitationOptions(schema);
    if (allowed.length > 0 && !allowed.some((entry) => entry.value === value)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is not an allowed value`,
            {},
            "invalid_elicitation_response",
        );
    }
}

function validateNumericValue(
    name: string,
    value: number,
    schema: Readonly<Record<string, unknown>>,
    integer: boolean,
): void {
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is not a valid number`,
            {},
            "invalid_elicitation_response",
        );
    }
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if ((typeof minimum === "number" && value < minimum) || (typeof maximum === "number" && value > maximum)) {
        throw new AcpExecutionError(
            `Elicitation field ${name} is outside the allowed range`,
            {},
            "invalid_elicitation_response",
        );
    }
}

function validateElicitationContent(
    encoded: string,
    requestedSchema: unknown,
): Readonly<Record<string, ElicitationContentValue>> {
    let decoded: unknown;
    try {
        decoded = JSON.parse(encoded);
    } catch (error) {
        throw new AcpExecutionError(
            "Elicitation response is not valid JSON",
            { cause: error },
            "invalid_elicitation_response",
        );
    }
    if (!isRecord(decoded) || !isRecord(requestedSchema) || !isRecord(requestedSchema["properties"])) {
        throw new AcpExecutionError(
            "Elicitation response does not match the requested form",
            {},
            "invalid_elicitation_response",
        );
    }
    const properties = requestedSchema["properties"];
    const requiredValue = requestedSchema["required"];
    const required = new Set<string>(
        Array.isArray(requiredValue) ? requiredValue.filter((entry) => typeof entry === "string") : [],
    );
    for (const name of required) {
        if (!(name in decoded)) {
            throw new AcpExecutionError(`Elicitation field ${name} is required`, {}, "invalid_elicitation_response");
        }
    }
    const validated: Record<string, ElicitationContentValue> = {};
    for (const [name, value] of Object.entries(decoded)) {
        const property = properties[name];
        if (!isRecord(property)) {
            throw new AcpExecutionError(
                `Elicitation field ${name} was not requested`,
                {},
                "invalid_elicitation_response",
            );
        }
        if (property["type"] === "string" && typeof value === "string") {
            validateStringValue(name, value, property);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "number" && typeof value === "number") {
            validateNumericValue(name, value, property, false);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "integer" && typeof value === "number") {
            validateNumericValue(name, value, property, true);
            validated[name] = value;
            continue;
        }
        if (property["type"] === "boolean" && typeof value === "boolean") {
            validated[name] = value;
            continue;
        }
        if (property["type"] === "array" && Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
            const minimum = property["minItems"];
            const maximum = property["maxItems"];
            if (
                (typeof minimum === "number" && value.length < minimum) ||
                (typeof maximum === "number" && value.length > maximum)
            ) {
                throw new AcpExecutionError(
                    `Elicitation field ${name} has an invalid selection count`,
                    {},
                    "invalid_elicitation_response",
                );
            }
            const allowed = normalizeElicitationOptions(property);
            if (allowed.length > 0 && value.some((entry) => !allowed.some((option) => option.value === entry))) {
                throw new AcpExecutionError(
                    `Elicitation field ${name} contains an invalid selection`,
                    {},
                    "invalid_elicitation_response",
                );
            }
            validated[name] = value;
            continue;
        }
        throw new AcpExecutionError(`Elicitation field ${name} has the wrong type`, {}, "invalid_elicitation_response");
    }
    return validated;
}

abstract class AcpTurnState {
    abstract readonly commandId: string;
    abstract readonly running: boolean;
    abstract readonly activities: AcpActivityTracker;
    abstract readonly onText: (text: string, messageId: string) => Promise<void>;
}

class IdleAcpTurn extends AcpTurnState {
    readonly commandId = SESSION_CONTROL_COMMAND_ID;
    readonly running = false;
    readonly activities = new AcpActivityTracker(
        () => Promise.resolve(),
        () => Promise.resolve(),
    );
    readonly onText = (): Promise<void> => Promise.resolve();
}

class RunningAcpTurn extends AcpTurnState {
    readonly commandId: string;
    readonly running = true;
    readonly activities: AcpActivityTracker;
    readonly onText: (text: string, messageId: string) => Promise<void>;

    constructor(
        commandId: string,
        onActivity: (activity: AcpActivity) => Promise<void>,
        onNarration: ((narration: AcpActivityNarration) => Promise<void>) | undefined,
        onText: (text: string, messageId: string) => Promise<void>,
        prepareContent: (content: AgentDisplayContent) => Promise<AgentDisplayContent>,
    ) {
        super();
        this.commandId = commandId;
        this.activities = new AcpActivityTracker(onActivity, onNarration ?? (() => Promise.resolve()), prepareContent);
        this.onText = onText;
    }
}

class PendingPermission {
    readonly completion = Promise.withResolvers<RequestPermissionResponse>();
    readonly interactionId: string;
    readonly optionIds: ReadonlySet<string>;
    #settled = false;

    constructor(interactionId: string, optionIds: ReadonlySet<string>) {
        this.interactionId = interactionId;
        this.optionIds = optionIds;
    }

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ outcome: { outcome: "cancelled" } });
        return true;
    };

    readonly select = (optionId: string): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({
            outcome: { optionId, outcome: "selected" },
        });
        return true;
    };
}

class PendingElicitation {
    readonly completion = Promise.withResolvers<CreateElicitationResponse>();
    readonly elicitationId: string;
    readonly interactionId: string;
    readonly requestedSchema: unknown;
    #settled = false;

    constructor(interactionId: string, elicitationId: string, requestedSchema: unknown) {
        this.elicitationId = elicitationId;
        this.interactionId = interactionId;
        this.requestedSchema = requestedSchema;
    }

    readonly accept = (content: Readonly<Record<string, ElicitationContentValue>>): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "accept", content });
        return true;
    };

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "cancel" });
        return true;
    };

    readonly decline = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "decline" });
        return true;
    };
}

class AcpProcessSession implements AcpClientHandler {
    readonly #additionalDirectories: readonly string[];
    readonly #acceptedUrlElicitations = new Map<string, string>();
    readonly #agentId: string;
    readonly #connection: ClientConnection;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #getObserver: () => AcpSessionObserver;
    readonly #inProcessAgent: InProcessAcpEndpoint | null;
    readonly #mobiusSessionId: string;
    readonly #pendingElicitations = new Map<string, PendingElicitation>();
    readonly #pendingPermissions = new Map<string, PendingPermission>();
    readonly #preSessionUpdates: SessionNotification[] = [];
    // Both topologies report a terminal outcome, even after a prompt's initial RPC is acknowledged.
    readonly #termination: Promise<AcpEndpointTermination>;
    readonly #runtimeChild: ReturnType<typeof spawn> | null;
    readonly #metrics: OperationMetrics;
    readonly #sessionConfigProtocol: SessionConfigProtocol;
    readonly #store: AcpSessionStore;
    readonly #emittedToolImages = new Set<string>();
    readonly #verifiedAgentVersion: string;
    #preSessionUpdateBytes = 0;
    #agentName = "";
    #agentVersion = "";
    #bufferedAgentText: readonly { readonly chunks: readonly string[]; readonly messageId: string }[] = [];
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    #configRevision = 0;
    #configOptions: readonly SessionConfigOption[] = [];
    #nativeSessionId = "";
    #prompted = false;
    #replay: { readonly kind: "idle" | "discard" } | { readonly kind: "capture"; readonly history: AcpHistoryReplay } =
        {
            kind: "idle",
        };
    #restored = false;
    #sessionTitle: string | null = null;
    #sessionUpdatedAt = "";
    #turn: AcpTurnState = new IdleAcpTurn();
    #updateTail: Promise<void> = Promise.resolve();

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        additionalDirectories: readonly string[],
        mobiusSessionId: string,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        metrics: OperationMetrics,
    ) {
        this.#additionalDirectories = [...additionalDirectories];
        this.#agentId = agent.id;
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#getObserver = getObserver;
        this.#mobiusSessionId = mobiusSessionId;
        this.#metrics = metrics;
        this.#sessionConfigProtocol = sessionConfigProtocolForAgent(agent.id);
        this.#store = store;
        this.#verifiedAgentVersion = agent.agentVersion;
        if (agent.kind === "in-process-acp") {
            // Mobius hosts the ACP Agent in-process and drives the vendor's own protocol, so there is
            // no adapter process to spawn or supervise here. The endpoint owns its own resources.
            const inProcess = agent.createEndpoint({
                command: agent.command,
                cwd,
                environment: agent.environment,
            });
            this.#inProcessAgent = inProcess;
            this.#runtimeChild = null;
            this.#termination = inProcess.terminated;
            this.#connection = createAcpClient(this).connect(inProcess.app());
            return;
        }
        this.#inProcessAgent = null;
        const child = spawn(agent.adapterPath, [...agent.arguments], {
            cwd,
            detached: process.platform !== "win32",
            env: { ...process.env, ...agent.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.#runtimeChild = child;
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (stdin === null || stdout === null || stderr === null) {
            child.kill("SIGKILL");
            throw new AcpExecutionError("ACP process streams are unavailable");
        }
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
            process.stderr.write(`[${agent.id}-acp] ${chunk}`);
        });
        this.#termination = new Promise<AcpEndpointTermination>((resolve) => {
            child.once("error", (cause) => {
                resolve({ kind: "failed", error: new AcpExecutionError("The ACP process could not run", { cause }) });
            });
            child.once("exit", (code, signal) => {
                resolve({
                    kind: "failed",
                    error: new AcpExecutionError("The ACP process stopped", { cause: { code, signal } }),
                });
            });
        });
        const stream = ndJsonStream(createWritableAcpStream(stdin), readableWebStream(stdout));
        this.#connection = createAcpClient(this).connect(stream);
    }

    static async #start(
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        initialize: (runtime: AcpProcessSession) => Promise<void>,
        metrics: OperationMetrics,
    ): Promise<AcpProcessSession> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            options.signal.throwIfAborted();
            const unchanged = await metrics.measure(
                "executable-validation",
                async () =>
                    await Promise.all([
                        // Only the adapter topology has an adapter executable to revalidate.
                        options.agent.kind === "acp-adapter-process"
                            ? revalidateExecutable(options.agent.adapterIdentity)
                            : Promise.resolve(true),
                        revalidateExecutable(options.agent.agentIdentity),
                    ]),
            );
            options.signal.throwIfAborted();
            if (unchanged.some((result) => !result)) {
                throw new AcpExecutionError(
                    "The local Agent runtime changed; restart Mobius before starting a new conversation",
                    {},
                    "agent_runtime_changed",
                );
            }
            const runtime = metrics.measureSync(
                "process-spawn",
                () =>
                    new AcpProcessSession(
                        options.agent,
                        options.cwd,
                        options.additionalDirectories,
                        options.sessionId,
                        getObserver,
                        store,
                        metrics,
                    ),
            );
            try {
                await initialize(runtime);
                return runtime;
            } catch (error) {
                await runtime.closeProcess();
                options.signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${options.agent.id}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", {
                    cause: error,
                });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    }

    static readonly start = async (
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpProcessSession> =>
        await AcpProcessSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.initialize(options.signal, options.origin),
            metrics,
        );

    static readonly startNativeSessionBrowser = async (
        options: AcpPrepareOptions,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
    ): Promise<AcpProcessSession> =>
        await AcpProcessSession.#start(
            options,
            getObserver,
            store,
            async (runtime) => await runtime.#initializeAgent(options.signal),
            unmeasuredOperationMetrics,
        );

    static readonly startSessionForkAtTurn = async (
        options: AcpPrepareOptions,
        sourceNativeSessionId: string,
        forkPoint: AcpSessionForkPoint,
        getObserver: () => AcpSessionObserver,
        store: AcpSessionStore,
    ): Promise<AcpProcessSession> =>
        await AcpProcessSession.#start(
            options,
            getObserver,
            store,
            async (runtime) =>
                await runtime.initialize(
                    options.signal,
                    { kind: "fork", nativeSessionId: sourceNativeSessionId },
                    forkPoint,
                ),
            unmeasuredOperationMetrics,
        );

    readonly belongsTo = (agentId: string, cwd: string, additionalDirectories: readonly string[]): boolean =>
        this.#agentId === agentId &&
        this.#cwd === cwd &&
        arraysEqual(this.#additionalDirectories, additionalDirectories);

    readonly usesEnvironment = (environment: Readonly<Record<string, string>>): boolean =>
        recordsEqual(this.#environment, environment);

    readonly canRebind = (): boolean => !this.#prompted && !this.#turn.running;

    readonly hasRunningTurn = (): boolean => this.#turn.running;

    readonly prepared = (): AcpPreparedSession =>
        new AcpPreparedSession(
            this.#agentName,
            this.#agentVersion,
            this.#capabilities,
            this.#commands,
            this.#configOptions,
            this.#restored,
        );

    readonly loadHistory = async (signal: AbortSignal): Promise<NativeSessionHistory> => {
        if (!this.#capabilities.loadSession) {
            return {
                status: "unavailable",
                cause: {
                    code: "native_history_unsupported",
                    message: "This Agent restores context but does not provide message history.",
                },
            };
        }
        const history = new AcpHistoryReplay();
        this.#replay = { kind: "capture", history };
        try {
            await this.race(
                this.#connection.agent.request(
                    methods.agent.session.load,
                    {
                        additionalDirectories: [...this.#additionalDirectories],
                        cwd: this.#cwd,
                        mcpServers: [],
                        sessionId: this.#nativeSessionId,
                    },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while loading history",
                signal,
            );
            await this.#updateTail;
            signal.throwIfAborted();
            return await embedLocalHistoryImages(await history.snapshot(), signal);
        } finally {
            this.#replay = { kind: "idle" };
        }
    };

    private readonly emitAgentMessage = async (chunks: readonly string[], messageId: string): Promise<void> => {
        const signal = AbortSignal.timeout(20_000);
        await emitMarkdownChunksWithLocalImages({
            chunks,
            onImage: async (image) => await this.emitRaster(image, messageId, signal),
            onText: async (content) => await this.#turn.onText(content, messageId),
            signal,
        });
    };

    private readonly bufferAgentText = async (text: string, messageId: string): Promise<void> => {
        const previous = this.#bufferedAgentText.at(-1);
        if (previous?.messageId === messageId) {
            this.#bufferedAgentText = [
                ...this.#bufferedAgentText.slice(0, -1),
                { chunks: [...previous.chunks, text], messageId },
            ];
            return;
        }
        this.#bufferedAgentText = [...this.#bufferedAgentText, { chunks: [text], messageId }];
    };

    private readonly flushAgentText = async (): Promise<void> => {
        const buffered = this.#bufferedAgentText;
        this.#bufferedAgentText = [];
        for (const message of buffered) {
            await this.emitAgentMessage(message.chunks, message.messageId);
        }
    };

    private readonly recordBufferedAgentTextAsProgress = async (): Promise<void> => {
        const buffered = this.#bufferedAgentText;
        this.#bufferedAgentText = [];
        for (const message of buffered) {
            for (const chunk of message.chunks) {
                await this.#turn.activities.recordNarrative("progress", message.messageId, chunk);
            }
        }
    };

    private readonly prepareAgentContent = async (content: AgentDisplayContent): Promise<AgentDisplayContent> => {
        if (content.type === "image" && content.uri.length > 0) {
            const signal = AbortSignal.timeout(20_000);
            const raster = await readLocalRaster(content.uri, signal);
            if (raster !== null) {
                return await this.importRaster(raster, signal);
            }
        }
        if (content.type === "image" && content.data.length > 0) {
            const raster = readInlineRaster(content.data, content.name);
            if (raster !== null) {
                return await this.importRaster(raster, AbortSignal.timeout(20_000));
            }
        }
        if (content.type === "video" && content.data.length > 0) {
            const video = readInlineVideo(content.data, content.mimeType, content.name);
            if (video === null) {
                return { ...content, data: "" };
            }
            return this.importVideo(video);
        }
        return content;
    };

    private readonly emitAgentContent = async (content: AgentDisplayContent, messageId: string): Promise<void> => {
        const prepared = await this.prepareAgentContent(content);
        await this.#getObserver().onContent({
            commandId: this.#turn.commandId,
            content: prepared,
            contentId: `content-${crypto.randomUUID()}`,
            kind: AGENT_CONTENT_KIND,
            messageId,
            sessionId: this.#mobiusSessionId,
        });
    };

    private readonly emitToolImages = async (update: ToolCallUpdate): Promise<void> => {
        if (update.status !== "completed") {
            return;
        }
        for (const [index, item] of (update.content ?? []).entries()) {
            if (item.type !== "content" || item.content.type !== "image") {
                continue;
            }
            const key = `${update.toolCallId}:${index.toString()}`;
            if (this.#emittedToolImages.has(key)) {
                continue;
            }
            this.#emittedToolImages.add(key);
            await this.emitAgentContent(normalizeContentBlock(item.content), `tool-${key}`);
        }
    };

    private readonly emitRaster = async (
        raster: LocalRasterImage,
        messageId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const content = await this.importRaster(raster, signal);
        await this.#getObserver().onContent({
            commandId: this.#turn.commandId,
            content,
            contentId: `content-${crypto.randomUUID()}`,
            kind: AGENT_CONTENT_KIND,
            messageId,
            sessionId: this.#mobiusSessionId,
        });
    };

    private readonly importRaster = async (
        raster: LocalRasterImage,
        _signal: AbortSignal,
    ): Promise<AgentDisplayContent> => {
        if (raster.sourceUri.length > 0) {
            return {
                ...imageDisplayContent(raster.mimeType, raster.name, "", ""),
                uri: raster.sourceUri,
            };
        }
        return imageDisplayContent(raster.mimeType, raster.name, await raster.base64(), "");
    };

    private readonly importVideo = (video: LocalVideo): AgentDisplayContent => ({
        artifactId: "",
        data: video.base64(),
        mimeType: video.mimeType,
        name: video.name,
        newText: "",
        oldText: "",
        path: "",
        terminalId: "",
        text: "",
        type: "video",
        uri: "",
    });

    async #initializeAgent(signal: AbortSignal): Promise<void> {
        await this.#metrics.measure("agent-initialize", async () => await this.#initializeAgentOperation(signal));
    }

    async #initializeAgentOperation(signal: AbortSignal): Promise<void> {
        if (this.#inProcessAgent !== null) {
            // The ACP agent runs in this process, but it still owns an app-server child that must
            // start and complete its own handshake before the ACP conversation can begin.
            await this.race(
                this.#inProcessAgent.initialize(signal),
                "The Codex app-server exited during initialization",
                signal,
            ).catch((cause: unknown) => {
                signal.throwIfAborted();
                throw new RetryableAcpInitializationError(cause);
            });
        }
        const initialized = await this.race(
            this.#connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {
                        elicitation: { form: {}, url: {} },
                        plan: {},
                        session: { configOptions: { boolean: {} } },
                    },
                    clientInfo: { name: "mobius", version: "0.0.3" },
                    protocolVersion: PROTOCOL_VERSION,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during initialization",
            signal,
        ).catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
            throw new AcpExecutionError(
                "ACP agent selected an unsupported protocol version",
                {},
                "unsupported_acp_protocol",
            );
        }
        this.#capabilities = normalizeAcpCapabilities(initialized);
        this.#agentName = truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? this.#agentId, 255);
        this.#agentVersion = truncate(
            this.#verifiedAgentVersion.length > 0 ? this.#verifiedAgentVersion : (initialized.agentInfo?.version ?? ""),
            128,
        );
    }

    readonly initialize = async (
        signal: AbortSignal,
        origin?: NativeSessionOrigin,
        forkPoint?: AcpSessionForkPoint,
    ): Promise<void> => {
        await this.#initializeAgent(signal);
        let stored = this.#metrics.measureSync("session-state-read", () =>
            origin?.kind === "import"
                ? new FoundAcpStoredSession(
                      new AcpStoredSession(
                          this.#mobiusSessionId,
                          this.#agentId,
                          nativeSessionIdSchema.parse(origin.nativeSessionId),
                          this.#cwd,
                          this.#additionalDirectories,
                          true,
                      ),
                  )
                : this.#store.read(this.#mobiusSessionId),
        );
        if (stored instanceof FoundAcpStoredSession && !stored.session.prompted) {
            this.#store.remove(this.#mobiusSessionId);
            stored = this.#metrics.measureSync("session-state-read", () => this.#store.read(this.#mobiusSessionId));
        }
        if (stored instanceof DeletedAcpStoredSession) {
            throw new AcpExecutionError(
                "The native Agent session was deleted. Start a new chat.",
                {},
                "native_session_deleted",
            );
        }
        let lifecycleResponse: unknown;
        if (origin?.kind === "fork") {
            if (!this.#capabilities.unstableForkSession) {
                throw new AcpExecutionError(
                    "This Agent does not support session forking",
                    {},
                    "native_session_unsupported",
                );
            }
            if (this.#additionalDirectories.length > 0 && !this.#capabilities.additionalDirectories) {
                throw new AcpExecutionError(
                    "This Agent cannot restore additional working directories",
                    {},
                    "native_session_unsupported",
                );
            }
            const forked = await this.#metrics.measure(
                "session-fork",
                async () =>
                    await this.race(
                        this.#connection.agent.request(
                            methods.agent.session.fork,
                            {
                                sessionId: nativeSessionIdSchema.parse(origin.nativeSessionId),
                                cwd: this.#cwd,
                                additionalDirectories: [...this.#additionalDirectories],
                                mcpServers: [],
                                ...(forkPoint === undefined
                                    ? {}
                                    : {
                                          _meta: {
                                              jetbrains: {
                                                  air: {
                                                      fork: {
                                                          version: 1,
                                                          messageFingerprint: forkPoint.messageFingerprint,
                                                          messageId: forkPoint.messageId,
                                                          messageOccurrence: forkPoint.messageOccurrence,
                                                      },
                                                  },
                                              },
                                          },
                                      }),
                            },
                            { cancellationSignal: signal },
                        ),
                        "ACP agent exited while forking a session",
                        signal,
                    ),
            );
            this.selectNativeSession(forked.sessionId);
            if (
                this.#nativeSessionId === origin.nativeSessionId ||
                this.#store.findNative(this.#agentId, this.#nativeSessionId).length > 0
            ) {
                throw new AcpExecutionError(
                    "The Agent did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            this.#prompted = true;
            this.#restored = true;
            lifecycleResponse = forked;
        } else if (
            stored instanceof FoundAcpStoredSession &&
            stored.session.agentId === this.#agentId &&
            stored.session.cwd === this.#cwd &&
            arraysEqual(stored.session.additionalDirectories, this.#additionalDirectories)
        ) {
            this.selectNativeSession(stored.session.nativeSessionId);
            this.#prompted = stored.session.prompted;
            this.#restored = true;
            if (this.#capabilities.resumeSession) {
                lifecycleResponse = await this.#metrics.measure(
                    "session-resume",
                    async () =>
                        await this.race(
                            this.#connection.agent.request(
                                methods.agent.session.resume,
                                {
                                    additionalDirectories: [...this.#additionalDirectories],
                                    cwd: this.#cwd,
                                    mcpServers: [],
                                    sessionId: this.#nativeSessionId,
                                },
                                { cancellationSignal: signal },
                            ),
                            "ACP agent exited while resuming a session",
                            signal,
                        ),
                );
            } else if (this.#capabilities.loadSession) {
                this.#replay = { kind: "discard" };
                try {
                    lifecycleResponse = await this.#metrics.measure(
                        "session-load",
                        async () =>
                            await this.race(
                                this.#connection.agent.request(
                                    methods.agent.session.load,
                                    {
                                        additionalDirectories: [...this.#additionalDirectories],
                                        cwd: this.#cwd,
                                        mcpServers: [],
                                        sessionId: this.#nativeSessionId,
                                    },
                                    { cancellationSignal: signal },
                                ),
                                "ACP agent exited while loading a session",
                                signal,
                            ),
                    );
                } finally {
                    await this.#updateTail;
                    this.#replay = { kind: "idle" };
                }
            } else {
                throw new AcpExecutionError(
                    "The ACP agent cannot restore its persisted session",
                    {},
                    "session_restore_unsupported",
                );
            }
        } else {
            if (stored instanceof FoundAcpStoredSession) {
                if (stored.session.prompted) {
                    throw new AcpExecutionError(
                        "The agent or workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                this.#store.remove(this.#mobiusSessionId);
            }
            const created = await this.#metrics.measure(
                "session-new",
                async () =>
                    await this.race(
                        this.#connection.agent.request(
                            methods.agent.session.new,
                            {
                                additionalDirectories: [...this.#additionalDirectories],
                                cwd: this.#cwd,
                                mcpServers: [],
                            },
                            { cancellationSignal: signal },
                        ),
                        "ACP agent exited while starting a session",
                        signal,
                    ),
            );
            this.selectNativeSession(created.sessionId);
            lifecycleResponse = created;
        }
        this.#configOptions = this.#sessionConfigProtocol.normalizeLifecycle(lifecycleResponse);
        await this.#updateTail;
        signal.throwIfAborted();
        if (this.#prompted) {
            this.#store.write(
                new AcpStoredSession(
                    this.#mobiusSessionId,
                    this.#agentId,
                    this.#nativeSessionId,
                    this.#cwd,
                    this.#additionalDirectories,
                    true,
                ),
            );
        }
    };

    readonly listNativeSessions = async (cursor: string | null, signal: AbortSignal): Promise<NativeSessionPage> => {
        if (!this.#capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const response: unknown = await this.race(
            this.#connection.agent.request(methods.agent.session.list, cursor === null ? {} : { cursor }, {
                cancellationSignal: signal,
            }),
            "ACP agent exited while listing sessions",
            signal,
        );
        const decoded = nativeSessionPageSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The Agent returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

    readonly deleteNativeSession = async (nativeSessionId: string, signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.deleteSession || !this.#capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session deletion",
                {},
                "native_session_unsupported",
            );
        }
        await this.race(
            this.#connection.agent.request(
                methods.agent.session.delete,
                { sessionId: nativeSessionIdSchema.parse(nativeSessionId) },
                { cancellationSignal: signal },
            ),
            "ACP agent exited while deleting a session",
            signal,
        );
    };

    readonly nativeSessionId = (): string => this.#nativeSessionId;

    readonly configure = async (options: AcpConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        const existing = this.#configOptions.find((option) => option.id === options.configId);
        if (existing === undefined || existing.type !== options.valueType) {
            throw new AcpExecutionError(
                "The requested ACP configuration option is unavailable",
                {},
                "invalid_session_configuration",
            );
        }
        if (existing.type === "select") {
            if (existing.values.length < 2) {
                throw new AcpExecutionError(
                    "The requested ACP configuration option is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            if (!existing.values.some((entry) => entry.value === options.value)) {
                throw new AcpConfigurationValueUnavailableError(
                    options.configId,
                    options.value,
                    existing.values.map((entry) => entry.value),
                );
            }
        }
        const configRevision = this.#configRevision;
        try {
            const configured = await this.#sessionConfigProtocol.configure(
                this.#configOptions,
                options,
                this.#nativeSessionId,
                {
                    request: async (method, params, failureMessage, signal) =>
                        await this.race(
                            this.#connection.agent.request(method, params, {
                                cancellationSignal: signal,
                            }),
                            failureMessage,
                            signal,
                        ),
                },
            );
            const applied = configured.find((option) => option.id === options.configId);
            if (
                applied === undefined ||
                applied.type !== options.valueType ||
                (applied.type === "boolean" && applied.booleanValue !== options.booleanValue) ||
                (applied.type === "select" && applied.currentValue !== options.value)
            ) {
                throw new AcpExecutionError(
                    "The Agent did not apply the requested session configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            await this.#updateTail;
            if (this.#configRevision === configRevision) {
                this.#configOptions = configured;
            }
        } catch (error) {
            if (error instanceof SessionConfigProtocolError) {
                throw new AcpExecutionError(error.message, { cause: error }, error.code);
            }
            throw error;
        }
        return this.#configOptions;
    };

    readonly buildPrompt = (options: AcpPromptContentOptions): ContentBlock[] => {
        if (options.images.length > 0 && !this.#capabilities.imagePrompt) {
            throw new AcpExecutionError(
                "The selected agent does not accept image prompts",
                {},
                "unsupported_prompt_content",
            );
        }
        if (
            options.resources.some((resource) => resource.type === "embedded") &&
            !this.#capabilities.embeddedContextPrompt
        ) {
            throw new AcpExecutionError(
                "The selected agent does not accept embedded context",
                {},
                "unsupported_prompt_content",
            );
        }
        const prompt: ContentBlock[] = [];
        if (options.prompt.length > 0) {
            prompt.push({ text: options.prompt, type: "text" });
        }
        for (const image of options.images) {
            prompt.push({
                _meta: { mobius: { name: image.name } },
                data: image.data,
                mimeType: image.mimeType,
                type: "image",
            });
        }
        for (const resource of options.resources) {
            if (resource.type === "embedded") {
                prompt.push({
                    resource: {
                        mimeType: resource.mimeType,
                        text: resource.text,
                        uri: resource.uri,
                    },
                    type: "resource",
                });
            } else {
                prompt.push({
                    mimeType: resource.mimeType,
                    name: resource.name,
                    type: "resource_link",
                    uri: resource.uri,
                });
            }
        }
        if (prompt.length === 0) {
            throw new AcpExecutionError("A prompt must contain text or an attachment", {}, "empty_prompt");
        }
        return prompt;
    };

    readonly prompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> => {
        if (this.#turn.running) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const prompt = this.buildPrompt(options);
        this.#store.write(
            new AcpStoredSession(
                this.#mobiusSessionId,
                this.#agentId,
                this.#nativeSessionId,
                this.#cwd,
                this.#additionalDirectories,
                true,
            ),
        );
        this.#prompted = true;
        const running = new RunningAcpTurn(
            options.commandId,
            options.onActivity,
            options.onNarration,
            options.onText,
            this.prepareAgentContent,
        );
        this.#turn = running;
        try {
            const response: unknown = await this.race(
                this.#connection.agent.request(
                    methods.agent.session.prompt,
                    { prompt, sessionId: this.#nativeSessionId },
                    { cancellationSignal: options.signal },
                ),
                "ACP agent exited during a prompt",
                options.signal,
            );
            await this.#updateTail;
            await this.flushAgentText();
            await running.activities.finish();
            let result: AcpPromptResult;
            try {
                result = decodeAgentPromptResponse(response);
            } catch (cause) {
                throw new AcpExecutionError(
                    "ACP agent returned an invalid prompt response",
                    { cause },
                    "acp_invalid_prompt_response",
                );
            }
            if (result.usage != null || result._meta?.quota !== undefined) {
                await this.#getObserver().onUsage({
                    _meta: result._meta ?? null,
                    commandId: options.commandId,
                    kind: SESSION_USAGE_UPDATED_KIND,
                    sessionId: this.#mobiusSessionId,
                    source: "prompt",
                    usage: result.usage ?? null,
                });
            }
            return result;
        } catch (error) {
            await running.activities.finish();
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError("ACP agent execution failed", {
                cause: error,
            });
        } finally {
            this.#bufferedAgentText = [];
            this.#turn = new IdleAcpTurn();
        }
    };

    readonly steer = async (options: AcpSteerOptions): Promise<string> => {
        if (!this.#capabilities.steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        if (!this.#turn.running || this.#turn.commandId !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        const prompt = this.buildPrompt(options);
        const response: unknown = await this.race(
            this.#connection.agent.request("_session/steering", {
                _meta: { steering: { idleBehavior: "promptRequired" } },
                prompt,
                sessionId: this.#nativeSessionId,
            }),
            "ACP agent exited during steering",
            options.signal,
        );
        if (!isRecord(response)) {
            throw new AcpExecutionError(
                "ACP agent returned an invalid steering response",
                {},
                "acp_invalid_steering_response",
            );
        }
        const outcome = response["outcome"];
        if (outcome === "injected" || outcome === "startedNewTurn") {
            return outcome;
        }
        if (outcome === "promptRequired") {
            throw new AcpExecutionError(
                "The target turn finished before steering could be injected",
                {},
                "steering_target_unavailable",
            );
        }
        if (outcome === "failed") {
            throw new AcpExecutionError("The Agent could not inject steering", {}, "steering_failed");
        }
        throw new AcpExecutionError(
            "ACP agent returned an invalid steering response",
            {},
            "acp_invalid_steering_response",
        );
    };

    readonly cancel = async (): Promise<void> => {
        const capturedProcesses = this.#runtimeChild === null ? [] : await captureProcessTree(this.#runtimeChild);
        try {
            await this.cancelPendingInteractions();
            if (this.#turn.running) {
                await this.#connection.agent.notify(methods.agent.session.cancel, {
                    sessionId: this.#nativeSessionId,
                });
            }
        } finally {
            await this.closeProcess(capturedProcesses);
        }
    };

    readonly respondPermission = async (options: AcpPermissionResponseOptions): Promise<void> => {
        const pending = this.#pendingPermissions.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The permission request is no longer active",
                {},
                "permission_request_not_found",
            );
        }
        if (options.outcome === "selected" && !pending.optionIds.has(options.optionId)) {
            throw new AcpExecutionError(
                "The selected permission option is unavailable",
                {},
                "invalid_permission_response",
            );
        }
        const resolved = options.outcome === "selected" ? pending.select(options.optionId) : pending.cancel();
        if (!resolved) {
            throw new AcpExecutionError(
                "The permission request was already resolved",
                {},
                "permission_request_not_found",
            );
        }
        this.#pendingPermissions.delete(options.interactionId);
        await this.#getObserver().onPermissionResolved({
            interactionId: options.interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: options.outcome === "selected" ? options.optionId : "",
            outcome: options.outcome,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly respondElicitation = async (options: AcpElicitationResponseOptions): Promise<void> => {
        const pending = this.#pendingElicitations.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The elicitation request is no longer active",
                {},
                "elicitation_request_not_found",
            );
        }
        let resolved = false;
        if (options.action === "accept") {
            if (pending.elicitationId.length > 0) {
                resolved = pending.accept({});
                if (resolved) {
                    this.#acceptedUrlElicitations.set(pending.elicitationId, pending.interactionId);
                }
            } else {
                resolved = pending.accept(validateElicitationContent(options.content, pending.requestedSchema));
            }
        } else if (options.action === "decline") {
            resolved = pending.decline();
        } else {
            resolved = pending.cancel();
        }
        if (!resolved) {
            throw new AcpExecutionError(
                "The elicitation request was already resolved",
                {},
                "elicitation_request_not_found",
            );
        }
        this.#pendingElicitations.delete(options.interactionId);
        await this.#getObserver().onElicitationResolved({
            action: options.action,
            interactionId: options.interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly onPermission = async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        this.assertNativeSession(request.sessionId);
        const interactionId = `permission-${crypto.randomUUID()}`;
        const options: SessionPermissionOption[] = request.options.slice(0, 20).map((option) => ({
            kind: option.kind,
            name: truncate(option.name, 255),
            optionId: truncate(option.optionId, 255),
        }));
        if (options.length === 0) {
            throw new AcpExecutionError(
                "ACP permission request did not provide any choices",
                {},
                "invalid_agent_permission_request",
            );
        }
        const pending = new PendingPermission(interactionId, new Set(options.map((option) => option.optionId)));
        this.#pendingPermissions.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelPermission(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#getObserver().onPermission({
                commandId: this.#turn.commandId,
                interactionId,
                kind: SESSION_PERMISSION_REQUESTED_KIND,
                options,
                sessionId: this.#mobiusSessionId,
                title: truncate(request.toolCall.title ?? "Permission required", 500),
                toolCallId: truncate(request.toolCall.toolCallId, 255),
                toolKind: truncate(request.toolCall.kind ?? "other", 64),
            });
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingPermissions.delete(interactionId);
        }
    };

    readonly onElicitation = async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        const sessionId = Reflect.get(request, "sessionId");
        if (typeof sessionId !== "string") {
            throw new AcpExecutionError(
                "Mobius only accepts session-scoped ACP elicitations",
                {},
                "unsupported_elicitation_scope",
            );
        }
        this.assertNativeSession(sessionId);
        if (request.mode !== "form" && request.mode !== "url") {
            throw new AcpExecutionError(
                "The ACP agent requested an unsupported elicitation mode",
                {},
                "unsupported_elicitation_mode",
            );
        }
        const interactionId = `elicitation-${crypto.randomUUID()}`;
        const schemaValue = Reflect.get(request, "requestedSchema");
        const requestedSchema = request.mode === "form" ? schemaValue : {};
        const elicitationIdValue = Reflect.get(request, "elicitationId");
        const elicitationId =
            request.mode === "url" && typeof elicitationIdValue === "string" ? truncate(elicitationIdValue, 255) : "";
        const pending = new PendingElicitation(interactionId, elicitationId, requestedSchema);
        this.#pendingElicitations.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelElicitation(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#getObserver().onElicitation({
                accepted: false,
                commandId: this.#turn.commandId,
                elicitationId,
                fields: normalizeElicitationFields(requestedSchema),
                interactionId,
                kind: SESSION_ELICITATION_REQUESTED_KIND,
                message: truncate(request.message, 2_000),
                mode: request.mode,
                sessionId: this.#mobiusSessionId,
                url:
                    request.mode === "url" && typeof Reflect.get(request, "url") === "string"
                        ? truncate(readString(Reflect.get(request, "url")), 4_096)
                        : "",
            });
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pendingElicitations.delete(interactionId);
        }
    };

    readonly onElicitationComplete = async (notification: CompleteElicitationNotification): Promise<void> => {
        const interactionId = this.#acceptedUrlElicitations.get(notification.elicitationId);
        if (interactionId === undefined) {
            return;
        }
        this.#acceptedUrlElicitations.delete(notification.elicitationId);
        await this.#getObserver().onElicitationResolved({
            action: "complete",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly onUpdate = (notification: SessionNotification): Promise<void> => {
        if (this.#nativeSessionId.length === 0) {
            const notificationBytes = Buffer.byteLength(JSON.stringify(notification));
            if (
                this.#preSessionUpdates.length >= MAX_PRE_SESSION_UPDATES ||
                this.#preSessionUpdateBytes + notificationBytes > MAX_PRE_SESSION_UPDATE_BYTES
            ) {
                return Promise.reject(
                    new AcpExecutionError(
                        "ACP agent sent too many updates before creating its session",
                        {},
                        "agent_update_limit",
                    ),
                );
            }
            this.#preSessionUpdates.push(notification);
            this.#preSessionUpdateBytes += notificationBytes;
            return Promise.resolve();
        }
        return this.enqueueUpdate(notification);
    };

    readonly enqueueUpdate = (notification: SessionNotification): Promise<void> => {
        this.#updateTail = this.#updateTail.then(async () => await this.processUpdate(notification));
        return this.#updateTail;
    };

    readonly selectNativeSession = (sessionId: string): void => {
        const selected = nativeSessionIdSchema.parse(sessionId);
        if (this.#nativeSessionId.length > 0 && this.#nativeSessionId !== selected) {
            throw new AcpExecutionError(
                "ACP agent attempted to replace the selected session",
                {},
                "invalid_agent_session",
            );
        }
        this.#nativeSessionId = selected;
        const pending = this.#preSessionUpdates.splice(0);
        this.#preSessionUpdateBytes = 0;
        for (const notification of pending) {
            void this.enqueueUpdate(notification);
        }
    };

    readonly processUpdate = async (notification: SessionNotification): Promise<void> => {
        this.assertNativeSession(notification.sessionId);
        const update = notification.update;
        if (this.#replay.kind === "capture") {
            await this.#replay.history.record(update);
        }
        if (
            this.#replay.kind !== "idle" &&
            (update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update" ||
                update.sessionUpdate === "plan" ||
                update.sessionUpdate === "plan_update" ||
                update.sessionUpdate === "plan_removed")
        ) {
            return;
        }
        if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "text") {
                if (isProgressMessage(update)) {
                    await this.#turn.activities.recordNarrative(
                        "progress",
                        update.messageId ?? "current",
                        update.content.text,
                    );
                } else {
                    await this.#turn.activities.finishNarrative();
                    await this.bufferAgentText(update.content.text, truncate(update.messageId ?? "", 255));
                }
            } else {
                await this.#turn.activities.finishNarrative();
                await this.flushAgentText();
                await this.emitAgentContent(
                    normalizeContentBlock(update.content),
                    truncate(update.messageId ?? "", 255),
                );
            }
            return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type === "text") {
                await this.#turn.activities.recordNarrative(
                    "reasoning",
                    update.messageId ?? "current",
                    update.content.text,
                );
            }
            return;
        }
        if (update.sessionUpdate === "tool_call") {
            await this.recordBufferedAgentTextAsProgress();
            await this.#turn.activities.recordToolCall(update);
            return;
        }
        if (update.sessionUpdate === "tool_call_update") {
            await this.#turn.activities.recordToolCallUpdate(update);
            await this.emitToolImages(update);
            return;
        }
        if (update.sessionUpdate === "plan") {
            await this.#turn.activities.recordPlan(update);
            return;
        }
        if (update.sessionUpdate === "plan_update") {
            await this.#turn.activities.recordPlanUpdate(update);
            return;
        }
        if (update.sessionUpdate === "plan_removed") {
            await this.#turn.activities.removePlan(update);
            return;
        }
        if (update.sessionUpdate === "available_commands_update") {
            const commands: SessionCommand[] = update.availableCommands
                .slice(0, 500)
                .map((command) => ({
                    description: truncate(command.description, 500),
                    inputHint: truncate(command.input?.hint ?? "", 255),
                    name: truncate(command.name, 128),
                }))
                .filter((command) => command.name.length > 0);
            this.#commands = commands;
            await this.#getObserver().onCommands({
                commands,
                kind: SESSION_COMMANDS_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
            });
            return;
        }
        if (update.sessionUpdate === "config_option_update") {
            this.#configOptions = this.#sessionConfigProtocol.normalizeUpdate(
                this.#configOptions,
                update.configOptions,
            );
            this.#configRevision += 1;
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "current_mode_update") {
            this.#configOptions = this.#configOptions.map((option) =>
                option.category === "mode" ? { ...option, currentValue: update.currentModeId } : option,
            );
            this.#configRevision += 1;
            await this.emitConfigUpdate();
            return;
        }
        if (update.sessionUpdate === "session_info_update") {
            if (Object.hasOwn(update, "title")) {
                this.#sessionTitle = truncate(update.title ?? "", 500);
            }
            if (Object.hasOwn(update, "updatedAt")) {
                this.#sessionUpdatedAt = truncate(update.updatedAt ?? "", 128);
            }
            await this.#getObserver().onInfo({
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
                title: this.#sessionTitle,
                updatedAt: this.#sessionUpdatedAt,
            });
            return;
        }
        if (update.sessionUpdate === "usage_update") {
            await this.#getObserver().onUsage({
                costAmount: update.cost?.amount ?? 0,
                costCurrency: truncate(update.cost?.currency ?? "", 16),
                hasCost: update.cost !== undefined && update.cost !== null,
                kind: SESSION_USAGE_UPDATED_KIND,
                sessionId: this.#mobiusSessionId,
                size: Math.max(0, Math.trunc(update.size)),
                source: "context",
                used: Math.max(0, Math.trunc(update.used)),
            });
        }
    };

    readonly close = async (): Promise<void> => {
        try {
            await this.cancelPendingInteractions();
            if (this.#capabilities.closeSession && this.#nativeSessionId.length > 0) {
                try {
                    await this.#connection.agent.request(
                        methods.agent.session.close,
                        { sessionId: this.#nativeSessionId },
                        {
                            cancellationSignal: AbortSignal.timeout(PROCESS_STOP_TIMEOUT_MILLISECONDS),
                        },
                    );
                } catch {
                    // Process teardown below remains authoritative.
                }
            }
        } finally {
            await this.closeProcess();
        }
    };

    readonly closeProcess = async (capturedProcesses: readonly ProcessTreeIdentity[] = []): Promise<void> => {
        try {
            if (this.#runtimeChild === null) {
                // The in-process agent owns its app-server child and its process tree.
                await this.#inProcessAgent?.close();
                return;
            }
            await stopProcessTree(this.#runtimeChild, capturedProcesses);
        } finally {
            this.#connection.close();
        }
    };

    readonly race = async <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> => {
        signal.throwIfAborted();
        let removeAbortListener = (): void => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = (): void => {
                reject(signal.reason ?? new Error("ACP request was cancelled"));
            };
            signal.addEventListener("abort", rejectAbort, { once: true });
            removeAbortListener = (): void => {
                signal.removeEventListener("abort", rejectAbort);
            };
        });
        try {
            try {
                return await Promise.race([
                    operation,
                    this.#termination.then((termination) => {
                        const cause = acpEndpointTerminationError(termination);
                        throw new AcpExecutionError(exitMessage, { cause }, cause.code);
                    }),
                    aborted,
                ]);
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof RequestError && error.code === -32_000) {
                    throw new AcpExecutionError(
                        "Agent authentication is required",
                        { cause: error },
                        "authentication_required",
                    );
                }
                if (error instanceof RequestError) {
                    throw new AcpExecutionError(truncate(error.message, 500), { cause: error }, "acp_agent_error");
                }
                throw error;
            }
        } finally {
            removeAbortListener();
        }
    };

    readonly assertNativeSession = (sessionId: string): void => {
        if (sessionId !== this.#nativeSessionId) {
            throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
        }
    };

    readonly emitConfigUpdate = async (): Promise<void> => {
        await this.#getObserver().onConfig({
            configOptions: this.#configOptions,
            kind: SESSION_CONFIG_UPDATED_KIND,
            requestId: `agent-update-${crypto.randomUUID()}`,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly cancelPermission = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingPermissions.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingPermissions.delete(interactionId);
        await this.#getObserver().onPermissionResolved({
            interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: "",
            outcome: "cancelled",
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly cancelElicitation = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingElicitations.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#pendingElicitations.delete(interactionId);
        await this.#getObserver().onElicitationResolved({
            action: "cancel",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#mobiusSessionId,
        });
    };

    readonly cancelPendingInteractions = async (): Promise<void> => {
        const permissionIds = [...this.#pendingPermissions.keys()];
        const elicitationIds = [...this.#pendingElicitations.keys()];
        const acceptedElicitationIds = [...this.#acceptedUrlElicitations.values()];
        this.#acceptedUrlElicitations.clear();
        for (const interactionId of permissionIds) {
            await this.cancelPermission(interactionId);
        }
        for (const interactionId of elicitationIds) {
            await this.cancelElicitation(interactionId);
        }
        for (const interactionId of acceptedElicitationIds) {
            await this.#getObserver().onElicitationResolved({
                action: "cancel",
                interactionId,
                kind: SESSION_ELICITATION_RESOLVED_KIND,
                sessionId: this.#mobiusSessionId,
            });
        }
    };
}

abstract class AcpProcessEvictionCandidate {}

class MissingAcpProcessEvictionCandidate extends AcpProcessEvictionCandidate {}

abstract class FoundAcpProcessEvictionCandidate extends AcpProcessEvictionCandidate {
    readonly runtime: AcpProcessSession;

    constructor(runtime: AcpProcessSession) {
        super();
        this.runtime = runtime;
    }
}

class FoundAcpSessionProcessEvictionCandidate extends FoundAcpProcessEvictionCandidate {
    readonly sessionId: string;

    constructor(sessionId: string, runtime: AcpProcessSession) {
        super(runtime);
        this.sessionId = sessionId;
    }
}

class FoundAcpNativeBrowserProcessEvictionCandidate extends FoundAcpProcessEvictionCandidate {
    readonly sessionId: string;

    constructor(sessionId: string, runtime: AcpProcessSession) {
        super(runtime);
        this.sessionId = sessionId;
    }
}

export class AcpSessionManager {
    readonly #activeCommandIds = new Map<string, string>();
    readonly #agentSettingsObserver = new NullAcpSessionObserver();
    readonly #nativeOperations = new Set<string>();
    readonly #nativeBrowserObserver = new NullAcpSessionObserver();
    readonly #nativeBrowserPreparing = new Map<string, Promise<AcpProcessSession>>();
    readonly #nativeBrowserSessions = new Map<string, AcpProcessSession>();
    readonly #nativeBrowserStore = new MemoryAcpSessionStore();
    readonly #nativeBrowserUseCounts = new Map<string, number>();
    readonly #activeSessionIds = new Set<string>();
    readonly #cancellationRequests = new Map<string, Promise<void>>();
    readonly #preparing = new Map<string, Promise<AcpProcessSession>>();
    #processCapacityChanged = Promise.withResolvers<void>();
    readonly #processCapacityLock = new AcpProcessCapacityLock();
    readonly #retainedProcesses = new Map<AcpProcessSession, FoundAcpProcessEvictionCandidate>();
    #retiringProcessCount = 0;
    readonly #sessionUseCounts = new Map<string, number>();
    readonly #sessions = new Map<string, AcpProcessSession>();
    #startingProcessCount = 0;
    #transientProcessCount = 0;
    readonly #store: AcpSessionStore;
    readonly #nativeHistoryReader: AcpNativeHistoryReader | null;
    #observer: AcpSessionObserver;

    constructor(
        observer: AcpSessionObserver = new NullAcpSessionObserver(),
        store: AcpSessionStore = new MemoryAcpSessionStore(),
        nativeHistoryReader: AcpNativeHistoryReader | null = null,
    ) {
        this.#observer = observer;
        this.#store = store;
        this.#nativeHistoryReader = nativeHistoryReader;
    }

    readonly setObserver = (observer: AcpSessionObserver): void => {
        this.#observer = observer;
    };

    #notifyProcessCapacityChanged(): void {
        const changed = this.#processCapacityChanged;
        this.#processCapacityChanged = Promise.withResolvers<void>();
        changed.resolve();
    }

    #touchSession(sessionId: string): void {
        const runtime = this.#sessions.get(sessionId);
        if (runtime === undefined) {
            return;
        }
        this.#touchProcess(runtime);
    }

    #touchExpectedSession(sessionId: string, expected: AcpProcessSession): void {
        if (this.#sessions.get(sessionId) !== expected) {
            return;
        }
        this.#touchProcess(expected);
    }

    #touchNativeBrowserSession(sessionId: string): void {
        const runtime = this.#nativeBrowserSessions.get(sessionId);
        if (runtime === undefined) {
            return;
        }
        this.#touchProcess(runtime);
    }

    #touchExpectedNativeBrowserSession(sessionId: string, expected: AcpProcessSession): void {
        if (this.#nativeBrowserSessions.get(sessionId) !== expected) {
            return;
        }
        this.#touchProcess(expected);
    }

    #touchProcess(runtime: AcpProcessSession): void {
        const retained = this.#retainedProcesses.get(runtime);
        if (retained === undefined) {
            return;
        }
        this.#retainedProcesses.delete(runtime);
        this.#retainedProcesses.set(runtime, retained);
    }

    #beginSessionUse(sessionId: string): void {
        this.#sessionUseCounts.set(sessionId, (this.#sessionUseCounts.get(sessionId) ?? 0) + 1);
        this.#touchSession(sessionId);
    }

    #endSessionUse(sessionId: string): void {
        const count = this.#sessionUseCounts.get(sessionId) ?? 0;
        if (count <= 1) {
            this.#sessionUseCounts.delete(sessionId);
        } else {
            this.#sessionUseCounts.set(sessionId, count - 1);
        }
        this.#touchSession(sessionId);
        this.#notifyProcessCapacityChanged();
    }

    #beginNativeBrowserUse(sessionId: string): void {
        this.#nativeBrowserUseCounts.set(sessionId, (this.#nativeBrowserUseCounts.get(sessionId) ?? 0) + 1);
        this.#touchNativeBrowserSession(sessionId);
    }

    #endNativeBrowserUse(sessionId: string): void {
        const count = this.#nativeBrowserUseCounts.get(sessionId) ?? 0;
        if (count <= 1) {
            this.#nativeBrowserUseCounts.delete(sessionId);
        } else {
            this.#nativeBrowserUseCounts.set(sessionId, count - 1);
        }
        this.#touchNativeBrowserSession(sessionId);
        this.#notifyProcessCapacityChanged();
    }

    #isNativeSessionOperationActive(sessionId: string): boolean {
        const stored = this.#store.read(sessionId);
        return (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        );
    }

    #leastRecentlyUsedEvictionCandidate(): AcpProcessEvictionCandidate {
        for (const candidate of this.#retainedProcesses.values()) {
            if (candidate instanceof FoundAcpSessionProcessEvictionCandidate) {
                if (
                    this.#activeSessionIds.has(candidate.sessionId) ||
                    this.#cancellationRequests.has(candidate.sessionId) ||
                    this.#preparing.has(candidate.sessionId) ||
                    (this.#sessionUseCounts.get(candidate.sessionId) ?? 0) > 0 ||
                    this.#isNativeSessionOperationActive(candidate.sessionId)
                ) {
                    continue;
                }
                return candidate;
            }
            if (
                candidate instanceof FoundAcpNativeBrowserProcessEvictionCandidate &&
                !this.#nativeBrowserPreparing.has(candidate.sessionId) &&
                (this.#nativeBrowserUseCounts.get(candidate.sessionId) ?? 0) === 0
            ) {
                return candidate;
            }
        }
        return new MissingAcpProcessEvictionCandidate();
    }

    #ownedProcessCount(): number {
        return (
            this.#retainedProcesses.size +
            this.#startingProcessCount +
            this.#transientProcessCount +
            this.#retiringProcessCount
        );
    }

    async #retireProcess(runtime: AcpProcessSession, retained: boolean, close: () => Promise<void>): Promise<void> {
        if (retained) {
            this.#retainedProcesses.delete(runtime);
            this.#retiringProcessCount += 1;
        }
        try {
            await close();
        } finally {
            if (retained) {
                this.#retiringProcessCount -= 1;
                this.#notifyProcessCapacityChanged();
            }
        }
    }

    async #retireSessionProcess(
        sessionId: string,
        runtime: AcpProcessSession,
        close: () => Promise<void>,
    ): Promise<void> {
        const retained = this.#sessions.get(sessionId) === runtime;
        if (retained) {
            this.#sessions.delete(sessionId);
        }
        await this.#retireProcess(runtime, retained, close);
    }

    async #retireNativeBrowserProcess(
        sessionId: string,
        runtime: AcpProcessSession,
        close: () => Promise<void>,
    ): Promise<void> {
        const retained = this.#nativeBrowserSessions.get(sessionId) === runtime;
        if (retained) {
            this.#nativeBrowserSessions.delete(sessionId);
            this.#nativeBrowserStore.remove(sessionId);
        }
        await this.#retireProcess(runtime, retained, close);
    }

    async #reserveProcessCapacity(signal: AbortSignal): Promise<void> {
        const lease = await this.#processCapacityLock.acquire(signal);
        try {
            for (;;) {
                signal.throwIfAborted();
                if (this.#ownedProcessCount() < MAX_ACP_PROCESSES) {
                    this.#startingProcessCount += 1;
                    return;
                }
                const candidate = this.#leastRecentlyUsedEvictionCandidate();
                if (candidate instanceof FoundAcpSessionProcessEvictionCandidate) {
                    await this.#retireSessionProcess(
                        candidate.sessionId,
                        candidate.runtime,
                        async () => await candidate.runtime.close(),
                    );
                    continue;
                }
                if (candidate instanceof FoundAcpNativeBrowserProcessEvictionCandidate) {
                    await this.#retireNativeBrowserProcess(
                        candidate.sessionId,
                        candidate.runtime,
                        async () => await candidate.runtime.close(),
                    );
                    continue;
                }
                const changed = this.#processCapacityChanged.promise;
                await waitForAcpProcessCapacity(changed, signal);
            }
        } finally {
            lease.release();
        }
    }

    async #startRetainedSessionProcess(
        options: AcpPrepareOptions,
        start: () => Promise<AcpProcessSession>,
    ): Promise<AcpProcessSession> {
        await this.#reserveProcessCapacity(options.signal);
        try {
            const runtime = await start();
            this.#startingProcessCount -= 1;
            this.#sessions.set(options.sessionId, runtime);
            this.#retainedProcesses.set(
                runtime,
                new FoundAcpSessionProcessEvictionCandidate(options.sessionId, runtime),
            );
            this.#notifyProcessCapacityChanged();
            return runtime;
        } catch (error) {
            this.#startingProcessCount -= 1;
            this.#notifyProcessCapacityChanged();
            throw error;
        }
    }

    async #startRetainedNativeBrowserProcess(
        options: AcpPrepareOptions,
        start: () => Promise<AcpProcessSession>,
    ): Promise<AcpProcessSession> {
        await this.#reserveProcessCapacity(options.signal);
        try {
            const runtime = await start();
            this.#startingProcessCount -= 1;
            this.#nativeBrowserSessions.set(options.sessionId, runtime);
            this.#retainedProcesses.set(
                runtime,
                new FoundAcpNativeBrowserProcessEvictionCandidate(options.sessionId, runtime),
            );
            this.#notifyProcessCapacityChanged();
            return runtime;
        } catch (error) {
            this.#startingProcessCount -= 1;
            this.#notifyProcessCapacityChanged();
            throw error;
        }
    }

    async #runWithTransientProcess<T>(
        signal: AbortSignal,
        start: () => Promise<AcpProcessSession>,
        operation: (runtime: AcpProcessSession) => Promise<T>,
        close: (runtime: AcpProcessSession) => Promise<void>,
    ): Promise<T> {
        await this.#reserveProcessCapacity(signal);
        let runtime: AcpProcessSession;
        try {
            runtime = await start();
        } catch (error) {
            this.#startingProcessCount -= 1;
            this.#notifyProcessCapacityChanged();
            throw error;
        }
        this.#startingProcessCount -= 1;
        this.#transientProcessCount += 1;
        this.#notifyProcessCapacityChanged();
        try {
            return await operation(runtime);
        } finally {
            try {
                await close(runtime);
            } finally {
                this.#transientProcessCount -= 1;
                this.#notifyProcessCapacityChanged();
            }
        }
    }

    async #startNativeBrowserPreparation(options: AcpPrepareOptions): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                return await this.#startRetainedNativeBrowserProcess(
                    options,
                    async () =>
                        await AcpProcessSession.startNativeSessionBrowser(
                            options,
                            () => this.#nativeBrowserObserver,
                            this.#nativeBrowserStore,
                        ),
                );
            } finally {
                this.#nativeBrowserPreparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#nativeBrowserPreparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replaceNativeBrowserPreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                await this.#retireNativeBrowserProcess(options.sessionId, existing, async () => await existing.close());
                return await this.#startRetainedNativeBrowserProcess(
                    options,
                    async () =>
                        await AcpProcessSession.startNativeSessionBrowser(
                            options,
                            () => this.#nativeBrowserObserver,
                            this.#nativeBrowserStore,
                        ),
                );
            } finally {
                this.#nativeBrowserPreparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#nativeBrowserPreparing.set(options.sessionId, operation);
        return await operation;
    }

    async #startPreparation(
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                return await this.#startRetainedSessionProcess(
                    options,
                    async () => await AcpProcessSession.start(options, () => this.#observer, this.#store, metrics),
                );
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    async #startSessionForkAtTurnPreparation(
        options: AcpPrepareOptions,
        sourceNativeSessionId: string,
        forkPoint: AcpSessionForkPoint,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                return await this.#startRetainedSessionProcess(
                    options,
                    async () =>
                        await AcpProcessSession.startSessionForkAtTurn(
                            options,
                            sourceNativeSessionId,
                            forkPoint,
                            () => this.#observer,
                            this.#store,
                        ),
                );
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replacePreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
        metrics: OperationMetrics,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                await this.#retireSessionProcess(
                    options.sessionId,
                    existing,
                    async () => await metrics.measure("runtime-replacement-close", async () => await existing.close()),
                );
                this.#store.remove(options.sessionId);
                return await this.#startRetainedSessionProcess(
                    options,
                    async () => await AcpProcessSession.start(options, () => this.#observer, this.#store, metrics),
                );
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replaceExecutionPreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
    ): Promise<AcpProcessSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        const operation = (async () => {
            try {
                await this.#retireSessionProcess(options.sessionId, existing, async () => await existing.close());
                const runtime = await this.#startRetainedSessionProcess(
                    options,
                    async () => await AcpProcessSession.start(options, () => this.#observer, this.#store),
                );
                try {
                    for (const desired of desiredConfigOptions) {
                        const current = runtime.prepared().configOptions.find((option) => option.id === desired.id);
                        if (current === undefined || current.type !== desired.type) {
                            continue;
                        }
                        if (desired.type === "boolean") {
                            if (current.booleanValue !== desired.booleanValue) {
                                await runtime.configure({
                                    ...options,
                                    booleanValue: desired.booleanValue,
                                    configId: desired.id,
                                    requestId: `execution-prepare-${desired.id}`,
                                    value: "",
                                    valueType: "boolean",
                                });
                            }
                            continue;
                        }
                        if (
                            current.currentValue !== desired.currentValue &&
                            current.values.some((value) => value.value === desired.currentValue)
                        ) {
                            await runtime.configure({
                                ...options,
                                booleanValue: false,
                                configId: desired.id,
                                requestId: `execution-prepare-${desired.id}`,
                                value: desired.currentValue,
                                valueType: "select",
                            });
                        }
                    }
                } catch (error) {
                    await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
                    throw error;
                }
                return runtime;
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    readonly prepareSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => {
        const stored = metrics.measureSync("session-state-read", () => this.#store.read(options.sessionId));
        if (stored instanceof DeletedAcpStoredSession) {
            throw new AcpExecutionError(
                "The native Agent session was deleted. Start a new chat.",
                {},
                "native_session_deleted",
            );
        }
        if (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        ) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            const runtime = await metrics.measure("session-preparation-wait", async () => await pending);
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedSession(options.sessionId, runtime);
                return runtime.prepared();
            }
            return await this.prepareSession(options, metrics);
        }
        const existing = this.#sessions.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedSession(options.sessionId, existing);
                return existing.prepared();
            }
            if (!existing.canRebind()) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            const runtime = await this.#replacePreparation(existing, options, metrics);
            return runtime.prepared();
        }
        const runtime = await this.#startPreparation(options, metrics);
        return runtime.prepared();
    };

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Mobius Session.
     */
    readonly inspectAgentSettings = async (
        options: AcpAgentSettingsInspectionOptions,
    ): Promise<AcpAgentSettingsSnapshot> =>
        await this.#runWithTransientProcess(
            options.signal,
            async () =>
                await AcpProcessSession.start(
                    {
                        ...options,
                        sessionId: `agent-settings-${crypto.randomUUID()}`,
                    },
                    () => this.#agentSettingsObserver,
                    new MemoryAcpSessionStore(),
                ),
            async (runtime) => {
                const prepared = runtime.prepared();
                const model = options.model;
                const configOptions =
                    model === undefined
                        ? prepared.configOptions
                        : await runtime.configure({
                              ...options,
                              booleanValue: false,
                              configId:
                                  prepared.configOptions.find(
                                      (option) => option.id === "model" || option.category === "model",
                                  )?.id ?? "model",
                              requestId: "agent-settings-model",
                              sessionId: `agent-settings-${crypto.randomUUID()}`,
                              value: model,
                              valueType: "select",
                          });
                return new AcpAgentSettingsSnapshot(prepared.agentName, prepared.agentVersion, configOptions);
            },
            async (runtime) => await runtime.close(),
        );

    /**
     * Retained for Agents that expose a separate persisted configuration channel.
     * Use inspectAgentSettings for Agent-scoped settings discovery.
     */
    readonly inspectSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => {
        if (this.#preparing.has(options.sessionId) || this.#sessions.has(options.sessionId)) {
            throw new AcpExecutionError("The configuration inspection session is already in use", {}, "session_busy");
        }
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.#startPreparation(options, metrics);
            try {
                return runtime.prepared();
            } finally {
                try {
                    await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
                } finally {
                    this.#store.remove(options.sessionId);
                }
            }
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly prepareExecutionSession = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> => {
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            await pending;
            return await this.prepareExecutionSession(options);
        }
        const existing = this.#sessions.get(options.sessionId);
        if (existing === undefined) {
            return (await this.#startPreparation(options)).prepared();
        }
        if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
            throw new AcpExecutionError(
                "The agent or workspace cannot change after a conversation has started",
                {},
                "session_identity_mismatch",
            );
        }
        if (existing.usesEnvironment(options.agent.environment)) {
            this.#touchExpectedSession(options.sessionId, existing);
            return existing.prepared();
        }
        if (existing.hasRunningTurn()) {
            throw new AcpExecutionError(
                "The execution environment cannot change while a conversation turn is running",
                {},
                "session_busy",
            );
        }
        return (await this.#replaceExecutionPreparation(existing, options)).prepared();
    };

    readonly prepareNativeSessionBrowser = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> => {
        const pending = this.#nativeBrowserPreparing.get(options.sessionId);
        if (pending !== undefined) {
            const runtime = await pending;
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedNativeBrowserSession(options.sessionId, runtime);
                return runtime.prepared();
            }
            return await this.prepareNativeSessionBrowser(options);
        }
        const existing = this.#nativeBrowserSessions.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedNativeBrowserSession(options.sessionId, existing);
                return existing.prepared();
            }
            if (!existing.canRebind()) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            const runtime = await this.#replaceNativeBrowserPreparation(existing, options);
            return runtime.prepared();
        }
        const runtime = await this.#startNativeBrowserPreparation(options);
        return runtime.prepared();
    };

    readonly configureSession = async (options: AcpConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.ensureSession(options);
            return await runtime.configure(options);
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly cancelPrompt = async (sessionId: string): Promise<void> => {
        const existing = this.#cancellationRequests.get(sessionId);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const cancellation = (async () => {
            const runtime = this.#sessions.get(sessionId);
            if (runtime !== undefined) {
                try {
                    await runtime.cancel();
                } finally {
                    if (this.#sessions.get(sessionId) === runtime) {
                        this.#sessions.delete(sessionId);
                        this.#retainedProcesses.delete(runtime);
                        this.#notifyProcessCapacityChanged();
                    }
                }
            }
        })();
        this.#cancellationRequests.set(sessionId, cancellation);
        await cancellation;
    };

    readonly steerPrompt = async (options: AcpSteerOptions): Promise<string> => {
        if (this.#activeCommandIds.get(options.sessionId) !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            await pending;
        }
        if (this.#activeCommandIds.get(options.sessionId) !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined || !runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
            throw new AcpExecutionError(
                "The target turn execution context is unavailable",
                {},
                "steering_target_unavailable",
            );
        }
        const deadlineController = new AbortController();
        const deadline = setTimeout(
            () =>
                deadlineController.abort(
                    new AcpExecutionError("The steering request exceeded its deadline", {}, "steering_timeout"),
                ),
            SESSION_CONTROL_TIMEOUT_MILLISECONDS,
        );
        deadline.unref();
        try {
            return await runtime.steer({
                ...options,
                signal: AbortSignal.any([options.signal, deadlineController.signal]),
            });
        } catch (error) {
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError("ACP agent steering failed", { cause: error }, "steering_failed");
        } finally {
            clearTimeout(deadline);
        }
    };

    readonly runPrompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> => {
        const stored = this.#store.read(options.sessionId);
        if (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        ) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        if (this.#activeSessionIds.has(options.sessionId)) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        this.#activeSessionIds.add(options.sessionId);
        this.#activeCommandIds.set(options.sessionId, options.commandId);
        try {
            if (this.#cancellationRequests.has(options.sessionId)) {
                return { stopReason: "cancelled" };
            }
            const runtime = await this.ensureSession(options);
            if (this.#nativeOperations.has(`${options.agent.id}:${runtime.nativeSessionId()}`)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            if (this.#cancellationRequests.has(options.sessionId)) {
                return { stopReason: "cancelled" };
            }
            try {
                const result = await runtime.prompt(options);
                return this.#cancellationRequests.has(options.sessionId) ? { stopReason: "cancelled" } : result;
            } catch (error) {
                if (this.#cancellationRequests.has(options.sessionId)) {
                    await this.#cancellationRequests.get(options.sessionId);
                    return { stopReason: "cancelled" };
                }
                throw error;
            }
        } catch (error) {
            const failedRuntime = this.#sessions.get(options.sessionId);
            if (failedRuntime !== undefined) {
                await this.#retireSessionProcess(
                    options.sessionId,
                    failedRuntime,
                    async () => await failedRuntime.close(),
                );
            }
            if (this.#cancellationRequests.has(options.sessionId)) {
                return { stopReason: "cancelled" };
            }
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError("ACP agent execution failed", {
                cause: error,
            });
        } finally {
            try {
                await this.#cancellationRequests.get(options.sessionId);
            } finally {
                this.#activeSessionIds.delete(options.sessionId);
                if (this.#activeCommandIds.get(options.sessionId) === options.commandId) {
                    this.#activeCommandIds.delete(options.sessionId);
                }
                this.#cancellationRequests.delete(options.sessionId);
                this.#touchSession(options.sessionId);
                this.#notifyProcessCapacityChanged();
            }
        }
    };

    readonly respondPermission = async (options: AcpPermissionResponseOptions): Promise<void> => {
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: AcpElicitationResponseOptions): Promise<void> => {
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The elicitation request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondElicitation(options);
    };

    readonly close = async (): Promise<void> => {
        const sessions = [...this.#sessions.entries()];
        const nativeBrowserSessions = [...this.#nativeBrowserSessions.entries()];
        await Promise.all([
            ...sessions.map(
                async ([sessionId, runtime]) =>
                    await this.#retireSessionProcess(sessionId, runtime, async () => await runtime.close()),
            ),
            ...nativeBrowserSessions.map(
                async ([sessionId, runtime]) =>
                    await this.#retireNativeBrowserProcess(sessionId, runtime, async () => await runtime.close()),
            ),
        ]);
    };

    readonly hasPreparedSession = (
        sessionId: string,
        agentId: string,
        cwd: string,
        additionalDirectories: readonly string[],
    ): boolean => this.#sessions.get(sessionId)?.belongsTo(agentId, cwd, additionalDirectories) === true;

    readonly ensureSession = async (options: AcpPrepareOptions): Promise<AcpProcessSession> => {
        const existing = this.#sessions.get(options.sessionId);
        if (existing !== undefined) {
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            this.#touchExpectedSession(options.sessionId, existing);
            return existing;
        }
        await this.prepareSession(options);
        const started = this.#sessions.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP session did not start");
        }
        return started;
    };

    async #ensureNativeSessionBrowser(options: AcpPrepareOptions): Promise<AcpProcessSession> {
        const existing = this.#nativeBrowserSessions.get(options.sessionId);
        if (existing !== undefined) {
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            this.#touchExpectedNativeBrowserSession(options.sessionId, existing);
            return existing;
        }
        await this.prepareNativeSessionBrowser(options);
        const started = this.#nativeBrowserSessions.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP native session browser did not start");
        }
        return started;
    }

    readonly listNativeSessions = async (
        options: AcpPrepareOptions,
        cursor: string | null,
    ): Promise<NativeSessionPage> => {
        this.#beginNativeBrowserUse(options.sessionId);
        try {
            return await (await this.#ensureNativeSessionBrowser(options)).listNativeSessions(cursor, options.signal);
        } finally {
            this.#endNativeBrowserUse(options.sessionId);
        }
    };

    readonly previewNativeSession = async (
        options: AcpPrepareOptions,
        nativeSessionId: string,
    ): Promise<NativeSessionHistory> => {
        const key = `${options.agent.id}:${nativeSessionId}`;
        const linked = this.#store.findNative(options.agent.id, nativeSessionId);
        if (
            this.#nativeOperations.has(key) ||
            linked.some((entry) => this.#activeSessionIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId))
        ) {
            throw new AcpExecutionError(
                "Wait for the native session's running operation to finish",
                {},
                "session_busy",
            );
        }
        this.#nativeOperations.add(key);
        try {
            return await this.#runWithTransientProcess(
                options.signal,
                async () =>
                    await AcpProcessSession.startNativeSessionBrowser(
                        options,
                        () => this.#nativeBrowserObserver,
                        new MemoryAcpSessionStore(),
                    ),
                async (runtime) => {
                    runtime.selectNativeSession(nativeSessionId);
                    return await runtime.loadHistory(options.signal);
                },
                async (runtime) => await runtime.closeProcess(),
            );
        } finally {
            this.#nativeOperations.delete(key);
        }
    };

    readonly loadSessionHistory = async (options: AcpPrepareOptions): Promise<NativeSessionHistory> => {
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.ensureSession(options);
            const stored = this.#store.read(options.sessionId);
            if (stored instanceof FoundAcpStoredSession && this.#nativeHistoryReader !== null) {
                const history = await this.#nativeHistoryReader.read(options, stored.session.nativeSessionId);
                if (history !== null) {
                    return history;
                }
            }
            return await runtime.loadHistory(options.signal);
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly openNativeSession = async (
        options: AcpPrepareOptions,
        origin: NativeSessionOrigin,
        loadHistory: boolean,
    ): Promise<{
        readonly sessionId: string;
        readonly prepared: AcpPreparedSession;
        readonly history: NativeSessionHistory;
    }> => {
        const key = `${options.agent.id}:${origin.nativeSessionId}`;
        if (this.#nativeOperations.has(key)) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        const linked = this.#store.findNative(options.agent.id, origin.nativeSessionId);
        if (
            linked.some((entry) => this.#activeSessionIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId))
        ) {
            throw new AcpExecutionError(
                "Wait for the native session's running operation to finish",
                {},
                "session_busy",
            );
        }
        const existing = linked[0];
        if (origin.kind === "import" && existing !== undefined) {
            this.#beginSessionUse(existing.sessionId);
            try {
                const runtime = await this.ensureSession({
                    ...options,
                    sessionId: existing.sessionId,
                });
                if (this.#activeSessionIds.has(existing.sessionId) || this.#nativeOperations.has(key)) {
                    throw new AcpExecutionError(
                        "Wait for the native session's running operation to finish",
                        {},
                        "session_busy",
                    );
                }
                this.#nativeOperations.add(key);
                try {
                    const history = loadHistory
                        ? await runtime.loadHistory(options.signal)
                        : nativeHistoryNotRetained();
                    return {
                        prepared: runtime.prepared(),
                        sessionId: existing.sessionId,
                        history,
                    };
                } catch (error) {
                    await this.#retireSessionProcess(
                        existing.sessionId,
                        runtime,
                        async () => await runtime.closeProcess(),
                    );
                    throw error;
                } finally {
                    this.#nativeOperations.delete(key);
                    this.#notifyProcessCapacityChanged();
                }
            } finally {
                this.#endSessionUse(existing.sessionId);
            }
        }
        if (
            this.#sessions.has(options.sessionId) ||
            this.#preparing.has(options.sessionId) ||
            this.#store.read(options.sessionId) instanceof FoundAcpStoredSession ||
            this.#store.read(options.sessionId) instanceof DeletedAcpStoredSession
        ) {
            throw new AcpExecutionError("The destination conversation already exists", {}, "session_identity_mismatch");
        }
        this.#beginSessionUse(options.sessionId);
        this.#nativeOperations.add(key);
        try {
            const runtime = await this.#startPreparation({ ...options, origin });
            const openedKey = `${options.agent.id}:${runtime.nativeSessionId()}`;
            this.#nativeOperations.add(openedKey);
            try {
                const history = loadHistory ? await runtime.loadHistory(options.signal) : nativeHistoryNotRetained();
                return {
                    sessionId: options.sessionId,
                    prepared: runtime.prepared(),
                    history,
                };
            } catch (error) {
                this.#store.remove(options.sessionId);
                await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.closeProcess());
                throw error;
            } finally {
                this.#nativeOperations.delete(openedKey);
                this.#notifyProcessCapacityChanged();
            }
        } catch (error) {
            this.#store.remove(options.sessionId);
            const runtime = this.#sessions.get(options.sessionId);
            if (runtime !== undefined) {
                await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.closeProcess());
            }
            throw error;
        } finally {
            this.#nativeOperations.delete(key);
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly forkSessionAtTurn = async (
        options: AcpPrepareOptions,
        sourceSessionId: string,
        forkPoint: AcpSessionForkPoint,
    ) => {
        if (sourceSessionId === options.sessionId) {
            throw new AcpExecutionError(
                "The fork destination must be a new conversation",
                {},
                "session_identity_mismatch",
            );
        }
        const source = this.#store.read(sourceSessionId);
        if (!(source instanceof FoundAcpStoredSession) || !source.session.prompted) {
            throw new AcpExecutionError(
                "The source conversation has no resumable native Agent session",
                {},
                "native_session_not_found",
            );
        }
        if (
            source.session.agentId !== options.agent.id ||
            source.session.cwd !== options.cwd ||
            !arraysEqual(source.session.additionalDirectories, options.additionalDirectories)
        ) {
            throw new AcpExecutionError(
                "The source conversation execution target does not match the fork request",
                {},
                "native_session_target_changed",
            );
        }
        const key = `${options.agent.id}:${source.session.nativeSessionId}`;
        const linked = this.#store.findNative(options.agent.id, source.session.nativeSessionId);
        if (
            this.#nativeOperations.has(key) ||
            linked.some((entry) => this.#activeSessionIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId))
        ) {
            throw new AcpExecutionError(
                "Wait for the source conversation's running operation to finish",
                {},
                "session_busy",
            );
        }
        if (
            this.#sessions.has(options.sessionId) ||
            this.#preparing.has(options.sessionId) ||
            this.#store.read(options.sessionId) instanceof FoundAcpStoredSession ||
            this.#store.read(options.sessionId) instanceof DeletedAcpStoredSession
        ) {
            throw new AcpExecutionError("The destination conversation already exists", {}, "session_identity_mismatch");
        }
        this.#beginSessionUse(options.sessionId);
        this.#nativeOperations.add(key);
        try {
            const runtime = await this.#startSessionForkAtTurnPreparation(
                options,
                source.session.nativeSessionId,
                forkPoint,
            );
            const openedKey = `${options.agent.id}:${runtime.nativeSessionId()}`;
            this.#nativeOperations.add(openedKey);
            try {
                return {
                    history: await runtime.loadHistory(options.signal),
                    prepared: runtime.prepared(),
                    sessionId: options.sessionId,
                };
            } catch (error) {
                this.#store.remove(options.sessionId);
                await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.closeProcess());
                throw error;
            } finally {
                this.#nativeOperations.delete(openedKey);
                this.#notifyProcessCapacityChanged();
            }
        } finally {
            this.#nativeOperations.delete(key);
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly deleteNativeSession = async (
        options: AcpPrepareOptions,
        nativeSessionId: string,
    ): Promise<readonly string[]> => {
        this.#beginNativeBrowserUse(options.sessionId);
        try {
            const runtime = await this.#ensureNativeSessionBrowser(options);
            const key = `${options.agent.id}:${nativeSessionId}`;
            const linked = this.#store.findNative(options.agent.id, nativeSessionId);
            if (
                this.#nativeOperations.has(key) ||
                linked.some(
                    (entry) => this.#activeSessionIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId),
                )
            ) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            try {
                for (const entry of linked) {
                    const active = this.#sessions.get(entry.sessionId);
                    if (active !== undefined && active !== runtime) {
                        await this.#retireSessionProcess(entry.sessionId, active, async () => await active.close());
                    }
                }
                options.signal.throwIfAborted();
                await runtime.deleteNativeSession(nativeSessionId, options.signal);
                const deleted = this.#store.markDeleted(options.agent.id, nativeSessionId);
                if (runtime.nativeSessionId() === nativeSessionId) {
                    await this.#retireNativeBrowserProcess(
                        options.sessionId,
                        runtime,
                        async () => await runtime.close(),
                    );
                }
                return deleted;
            } finally {
                this.#nativeOperations.delete(key);
                this.#notifyProcessCapacityChanged();
            }
        } finally {
            this.#endNativeBrowserUse(options.sessionId);
        }
    };
}
