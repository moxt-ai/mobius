import {
    AGENT_ACTIVITY_KIND,
    type CommandReceipt,
    type CommittedSessionEvent,
    decodeCommandReceipt,
    decodeCommittedSessionEvent,
    decodeInteraction,
    decodeNativeSessionHistory,
    decodeRecordedSessionEvent,
    decodeSessionBinding,
    decodeSessionPromptCommand,
    decodeTurn,
    type Interaction,
    type NativeSessionHistory,
    type RecordedSessionEvent,
    SESSION_PROMPT_KIND,
    type SessionBinding,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import { ArtifactContent, AvailableArtifactDescriptor, SessionRuntimeError } from "../../entity/do/session.ts";
import type { ImportedActivity, ImportedCommand } from "../../entity/do/session-import.ts";
import { decodeBase64, sha256 } from "./session-archive-codec.ts";
import { hasExactKeys, isRecord } from "./session-codec.ts";
import {
    DECIMAL_SEQUENCE_PATTERN,
    DEFAULT_CONTENT_LIMIT_BYTES,
    decodeActivityDetailPayload,
    IDENTIFIER_PATTERN,
    MAX_EXPORT_BYTE_LENGTH,
} from "./session-records.ts";

interface ImportedArtifact {
    readonly attemptId: string;
    readonly payload: string;
    readonly toolCallId: string;
}

export interface DecodedSessionImport {
    readonly activities: readonly ImportedActivity[];
    readonly agentId: string;
    readonly artifacts: ReadonlyMap<string, ImportedArtifact>;
    readonly bindingId: string;
    readonly bindings: readonly SessionBinding[];
    readonly commands: readonly ImportedCommand[];
    readonly contentLimitBytes: number;
    readonly createdBy: string;
    readonly directoryId: string;
    readonly eventPayloadHashes: ReadonlyMap<string, string>;
    readonly events: readonly CommittedSessionEvent[];
    readonly hotEventLimit: number;
    readonly idempotencyRetentionMilliseconds: number;
    readonly interactions: readonly Interaction[];
    readonly level: "full" | "summary";
    readonly minimumSequenceNumber: number;
    readonly nativeHistory: NativeSessionHistory | null;
    readonly nextSequenceNumber: number;
    readonly retentionMilliseconds: number;
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly uploadedArtifacts: readonly ArtifactContent[];
}

function importString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw new SessionRuntimeError("invalid_export", `The exported ${key} is invalid`);
    }
    return field;
}

export async function decodeSessionImport(exported: unknown, signal: AbortSignal): Promise<DecodedSessionImport> {
    signal.throwIfAborted();
    if (
        !isRecord(exported) ||
        !hasExactKeys(exported, [
            "artifacts",
            "bindings",
            "commandReceipts",
            "events",
            "interactions",
            "minimumSequence",
            "nativeHistory",
            "nextSequence",
            "session",
            "toolCallViews",
            "turns",
            "uploadedArtifacts",
        ])
    ) {
        throw new SessionRuntimeError("invalid_export", "The session export is invalid");
    }
    let encodedExport: string;
    try {
        encodedExport = JSON.stringify(exported);
    } catch (cause) {
        throw new SessionRuntimeError("invalid_export", "The session export is invalid", { cause });
    }
    if (new TextEncoder().encode(encodedExport).byteLength > MAX_EXPORT_BYTE_LENGTH * 2) {
        throw new SessionRuntimeError("invalid_export", "The session export is too large");
    }

    const importIdentifier = (value: Readonly<Record<string, unknown>>, key: string): string => {
        const identifier = importString(value, key, 128);
        if (!IDENTIFIER_PATTERN.test(identifier)) {
            throw new SessionRuntimeError("invalid_export", `The exported ${key} is invalid`);
        }
        return identifier;
    };
    const importTimestamp = (value: Readonly<Record<string, unknown>>, key: string): number => {
        const timestamp = Date.parse(importString(value, key, 64));
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
            throw new SessionRuntimeError("invalid_export", `The exported ${key} is invalid`);
        }
        return timestamp;
    };

    const sourceSession = exported["session"];
    const bindingValues = exported["bindings"];
    const commandReceiptValues = exported["commandReceipts"];
    const eventValues = exported["events"];
    const interactionValues = exported["interactions"];
    const commandValues = exported["turns"];
    const activityValues = exported["toolCallViews"];
    const artifactValues = exported["artifacts"];
    const uploadedArtifactValues = exported["uploadedArtifacts"];
    const nativeHistoryValue = exported["nativeHistory"];
    if (
        !isRecord(sourceSession) ||
        !Array.isArray(bindingValues) ||
        !Array.isArray(commandReceiptValues) ||
        !Array.isArray(eventValues) ||
        !Array.isArray(interactionValues) ||
        !Array.isArray(commandValues) ||
        !Array.isArray(activityValues) ||
        !Array.isArray(artifactValues) ||
        !Array.isArray(uploadedArtifactValues) ||
        eventValues.length > 100_000 ||
        commandValues.length > 10_000 ||
        activityValues.length > 100_000 ||
        artifactValues.length > 100_000 ||
        uploadedArtifactValues.length > 1_000 ||
        bindingValues.length > 10_000 ||
        commandReceiptValues.length > 10_000 ||
        interactionValues.length > 100_000
    ) {
        throw new SessionRuntimeError("invalid_export", "The session export is invalid");
    }
    const portableSessionFields = [
        "agentId",
        "createdAt",
        "createdBy",
        "defaultBinding",
        "hasNativeHistory",
        "lastCommittedSeq",
        "lifecycle",
        "policy",
        "projectId",
        "runtimeId",
        "sessionId",
        "title",
        "updatedAt",
    ];
    if (!hasExactKeys(sourceSession, portableSessionFields)) {
        throw new SessionRuntimeError("invalid_export", "The exported session descriptor is invalid");
    }
    const lifecycle = sourceSession["lifecycle"];
    if (!isRecord(lifecycle) || !hasExactKeys(lifecycle, ["kind"]) || lifecycle["kind"] !== "ready") {
        throw new SessionRuntimeError("invalid_export", "Only an active session can be imported");
    }
    const sessionId = importIdentifier(sourceSession, "sessionId");
    const runtimeId = importIdentifier(sourceSession, "runtimeId");
    const agentId = importIdentifier(sourceSession, "agentId");
    const createdBy = importIdentifier(sourceSession, "createdBy");
    const defaultBinding = sourceSession["defaultBinding"];
    if (!isRecord(defaultBinding)) {
        throw new SessionRuntimeError("invalid_export", "The exported default binding is invalid");
    }
    let decodedDefaultBinding: SessionBinding;
    try {
        decodedDefaultBinding = decodeSessionBinding(defaultBinding);
    } catch (cause) {
        throw new SessionRuntimeError("invalid_export", "The exported default binding is invalid", { cause });
    }
    const sourceProjectId = importIdentifier(sourceSession, "projectId");
    importTimestamp(sourceSession, "createdAt");
    importTimestamp(sourceSession, "updatedAt");
    const bindingId = decodedDefaultBinding.bindingId;
    const directoryId = decodedDefaultBinding.workspaceRef;
    const bindings: SessionBinding[] = [];
    const bindingIds = new Set<string>();
    for (const value of bindingValues) {
        let binding: SessionBinding;
        try {
            binding = decodeSessionBinding(value);
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An exported SessionBinding is invalid", { cause });
        }
        if (binding.sessionId !== sessionId || bindingIds.has(binding.bindingId)) {
            throw new SessionRuntimeError("invalid_export", "An exported SessionBinding is invalid");
        }
        bindingIds.add(binding.bindingId);
        bindings.push(binding);
    }
    if (
        !bindingIds.has(bindingId) ||
        decodedDefaultBinding.sessionId !== sessionId ||
        decodedDefaultBinding.runtimeId !== runtimeId ||
        decodedDefaultBinding.agentRef !== agentId
    ) {
        throw new SessionRuntimeError("invalid_export", "The exported default binding is inconsistent");
    }
    const title = importString(sourceSession, "title", 500, true);
    let nativeHistory: NativeSessionHistory | null = null;
    let nativeHistoryByteLength = 0;
    if (nativeHistoryValue !== null) {
        try {
            nativeHistory = decodeNativeSessionHistory(nativeHistoryValue);
            nativeHistoryByteLength = new TextEncoder().encode(JSON.stringify(nativeHistory)).byteLength;
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "The exported native Session history is invalid", {
                cause,
            });
        }
    }
    if (sourceSession["hasNativeHistory"] !== (nativeHistory !== null)) {
        throw new SessionRuntimeError("invalid_export", "The exported native Session history is inconsistent");
    }
    const policy = sourceSession["policy"];
    if (
        !isRecord(policy) ||
        !hasExactKeys(policy, [
            "contentLimitBytes",
            "hotEventLimit",
            "idempotencyRetentionMilliseconds",
            "level",
            "retentionMilliseconds",
        ])
    ) {
        throw new SessionRuntimeError("invalid_export", "The session policy is invalid");
    }
    const level = policy["level"];
    const retentionMilliseconds = policy["retentionMilliseconds"];
    const hotEventLimit = policy["hotEventLimit"];
    const idempotencyRetentionMilliseconds = policy["idempotencyRetentionMilliseconds"];
    const contentLimitBytes = policy["contentLimitBytes"];
    if (
        (level !== "full" && level !== "summary") ||
        typeof retentionMilliseconds !== "number" ||
        !Number.isSafeInteger(retentionMilliseconds) ||
        retentionMilliseconds < 60_000 ||
        retentionMilliseconds > 365 * 24 * 60 * 60 * 1_000 ||
        typeof hotEventLimit !== "number" ||
        !Number.isSafeInteger(hotEventLimit) ||
        hotEventLimit < 10 ||
        hotEventLimit > 10_000 ||
        typeof idempotencyRetentionMilliseconds !== "number" ||
        !Number.isSafeInteger(idempotencyRetentionMilliseconds) ||
        idempotencyRetentionMilliseconds < 60_000 ||
        idempotencyRetentionMilliseconds > retentionMilliseconds ||
        typeof contentLimitBytes !== "number" ||
        !Number.isSafeInteger(contentLimitBytes) ||
        contentLimitBytes < 1_024 ||
        contentLimitBytes > DEFAULT_CONTENT_LIMIT_BYTES ||
        nativeHistoryByteLength > contentLimitBytes
    ) {
        throw new SessionRuntimeError("invalid_export", "The session policy is invalid");
    }
    const minimumSequence = exported["minimumSequence"];
    const nextSequence = exported["nextSequence"];
    const minimumSequenceNumber =
        typeof minimumSequence === "string" && DECIMAL_SEQUENCE_PATTERN.test(minimumSequence)
            ? Number(minimumSequence)
            : Number.NaN;
    const nextSequenceNumber =
        typeof nextSequence === "string" && DECIMAL_SEQUENCE_PATTERN.test(nextSequence)
            ? Number(nextSequence)
            : Number.NaN;
    if (
        !Number.isSafeInteger(minimumSequenceNumber) ||
        minimumSequenceNumber < 1 ||
        !Number.isSafeInteger(nextSequenceNumber) ||
        nextSequenceNumber < minimumSequenceNumber
    ) {
        throw new SessionRuntimeError("invalid_export", "The exported event range is invalid");
    }

    const events: CommittedSessionEvent[] = [];
    const decodedEvents = new Map<number, RecordedSessionEvent>();
    const eventPayloadHashes = new Map<string, string>();
    const eventIds = new Set<string>();
    let expectedSequence = minimumSequenceNumber;
    for (const value of eventValues) {
        let committed: CommittedSessionEvent;
        let decodedEvent: RecordedSessionEvent;
        try {
            committed = decodeCommittedSessionEvent(JSON.stringify(value));
            decodedEvent = decodeRecordedSessionEvent(committed.payload);
            if (decodedEvent.sessionId !== sessionId) {
                throw new Error("Event payload belongs to another session");
            }
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "The exported event stream is invalid", { cause });
        }
        const committedSequence = Number(committed.sequence);
        if (
            committed.sessionId !== sessionId ||
            !Number.isSafeInteger(committedSequence) ||
            committedSequence.toString() !== committed.sequence ||
            committedSequence !== expectedSequence ||
            eventIds.has(committed.eventId)
        ) {
            throw new SessionRuntimeError("invalid_export", "The exported event sequence is invalid");
        }
        eventIds.add(committed.eventId);
        events.push(committed);
        eventPayloadHashes.set(committed.eventId, await sha256(new TextEncoder().encode(committed.payload)));
        decodedEvents.set(committedSequence, decodedEvent);
        expectedSequence += 1;
    }
    if (expectedSequence !== nextSequenceNumber) {
        throw new SessionRuntimeError("invalid_export", "The exported event range is incomplete");
    }

    const commands: ImportedCommand[] = [];
    const commandIds = new Set<string>();
    const commandsByIdempotencyKey = new Map<string, ImportedCommand>();
    const commandsByTurnId = new Map<string, ImportedCommand>();
    const attemptIds = new Set<string>();
    const attemptIdsByCommand = new Map<string, string>();
    for (const value of commandValues) {
        if (
            !isRecord(value) ||
            !hasExactKeys(value, ["command", "createdAt", "response", "state", "turn", "updatedAt"])
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported command is invalid");
        }
        let command: SessionPromptCommand;
        let turn: Turn;
        try {
            command = decodeSessionPromptCommand(JSON.stringify(value["command"]));
            turn = decodeTurn(value["turn"]);
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An exported command is invalid", { cause });
        }
        const createdAt = importTimestamp(value, "createdAt");
        const updatedAt = importTimestamp(value, "updatedAt");
        const response = importString(value, "response", 100_000, true);
        const stateValue = value["state"];
        if (
            command.sessionId !== sessionId ||
            turn.sessionId !== sessionId ||
            turn.idempotencyKey !== command.commandId ||
            turn.bindingId !== command.bindingId ||
            !bindingIds.has(turn.bindingId) ||
            turn.request.kind !== "prompt" ||
            turn.request.content !== command.prompt ||
            JSON.stringify(turn.request.sessionConfigurations) !==
                JSON.stringify(command.sessionConfigurations ?? []) ||
            commandIds.has(command.commandId) ||
            !isRecord(stateValue)
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported command is invalid");
        }
        commandIds.add(command.commandId);
        const requestHash = await sha256(new TextEncoder().encode(JSON.stringify(command)));
        let state: ImportedCommand["state"];
        let attemptId: string | null = null;
        let startedAt: number | null = null;
        let completedAt: number | null = null;
        let stopReason: string | null = null;
        let errorCode: string | null = null;
        let errorMessage: string | null = null;
        const kind = stateValue["kind"];
        if (kind === "queued" && hasExactKeys(stateValue, ["kind"])) {
            state = "queued";
        } else if (kind === "running" && hasExactKeys(stateValue, ["kind", "attemptId", "startedAt"])) {
            state = "running";
            attemptId = importIdentifier(stateValue, "attemptId");
            startedAt = importTimestamp(stateValue, "startedAt");
        } else if (
            kind === "succeeded" &&
            hasExactKeys(stateValue, ["completedAt", "kind", "attemptId", "startedAt", "stopReason"])
        ) {
            state = "succeeded";
            attemptId = importIdentifier(stateValue, "attemptId");
            startedAt = importTimestamp(stateValue, "startedAt");
            completedAt = importTimestamp(stateValue, "completedAt");
            stopReason = importString(stateValue, "stopReason", 128, true);
        } else if (
            kind === "indeterminate" &&
            hasExactKeys(stateValue, ["detectedAt", "kind", "attemptId", "startedAt"])
        ) {
            state = "indeterminate";
            attemptId = importIdentifier(stateValue, "attemptId");
            startedAt = importTimestamp(stateValue, "startedAt");
        } else if (
            kind === "cancelled" &&
            hasExactKeys(stateValue, ["attemptId", "cancelledAt", "kind", "startedAt"])
        ) {
            state = "cancelled";
            attemptId = importIdentifier(stateValue, "attemptId");
            startedAt = importTimestamp(stateValue, "startedAt");
            completedAt = importTimestamp(stateValue, "cancelledAt");
            stopReason = "cancelled";
        } else if (
            kind === "failed" &&
            hasExactKeys(stateValue, ["code", "failedAt", "kind", "message", "attemptId", "startedAt"])
        ) {
            state = "failed";
            completedAt = importTimestamp(stateValue, "failedAt");
            errorCode = importString(stateValue, "code", 128);
            errorMessage = importString(stateValue, "message", 2_000, true);
            const processValue = stateValue["attemptId"];
            const startedValue = stateValue["startedAt"];
            if (processValue === null && startedValue === null) {
                attemptId = null;
                startedAt = null;
            } else if (typeof processValue === "string" && typeof startedValue === "string") {
                attemptId = importIdentifier(stateValue, "attemptId");
                startedAt = importTimestamp(stateValue, "startedAt");
            } else {
                throw new SessionRuntimeError("invalid_export", "An exported command attempt is invalid");
            }
        } else {
            throw new SessionRuntimeError("invalid_export", "An exported command state is invalid");
        }
        commands.push({
            bindingId: turn.bindingId,
            command,
            completedAt,
            createdAt,
            errorCode,
            errorMessage,
            idempotencyKey: turn.idempotencyKey,
            attemptId,
            requestHash,
            response,
            startedAt,
            state,
            stopReason,
            turnId: turn.turnId,
            updatedAt,
        });
        const imported = commands.at(-1);
        if (imported === undefined) {
            throw new SessionRuntimeError("invalid_export", "An exported command could not be retained");
        }
        commandsByIdempotencyKey.set(imported.idempotencyKey, imported);
        commandsByTurnId.set(imported.turnId, imported);
        if (attemptId !== null) {
            attemptIdsByCommand.set(command.commandId, attemptId);
            attemptIds.add(attemptId);
        }
    }
    const commandReceipts: CommandReceipt[] = [];
    const receiptKeys = new Set<string>();
    for (const value of commandReceiptValues) {
        let receipt: CommandReceipt;
        try {
            receipt = decodeCommandReceipt(value);
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An exported CommandReceipt is invalid", { cause });
        }
        const command = commandsByIdempotencyKey.get(receipt.idempotencyKey);
        if (
            receipt.projectId !== sourceProjectId ||
            receipt.sessionId !== sessionId ||
            receipt.commandKind !== SESSION_PROMPT_KIND ||
            command === undefined ||
            receipt.resultId !== command.turnId ||
            receipt.requestHash !== command.requestHash ||
            Date.parse(receipt.acceptedAt) !== command.createdAt ||
            Date.parse(receipt.expiresAt) !== command.createdAt + idempotencyRetentionMilliseconds ||
            receiptKeys.has(receipt.idempotencyKey)
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported CommandReceipt is inconsistent");
        }
        receiptKeys.add(receipt.idempotencyKey);
        commandReceipts.push(receipt);
    }
    if (commandReceipts.length !== commands.length) {
        throw new SessionRuntimeError("invalid_export", "The exported CommandReceipt set is incomplete");
    }
    const interactions: Interaction[] = [];
    const interactionIds = new Set<string>();
    for (const value of interactionValues) {
        let interaction: Interaction;
        try {
            interaction = decodeInteraction(value);
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An exported Interaction is invalid", { cause });
        }
        const owningCommand = commandsByTurnId.get(interaction.turnId);
        if (
            interaction.sessionId !== sessionId ||
            owningCommand?.attemptId !== interaction.attemptId ||
            !attemptIds.has(interaction.attemptId) ||
            interactionIds.has(interaction.interactionId) ||
            interaction.state.kind === "pending" ||
            interaction.state.kind === "responded"
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported Interaction is inconsistent");
        }
        interactionIds.add(interaction.interactionId);
        interactions.push(interaction);
    }
    for (const event of decodedEvents.values()) {
        if ("commandId" in event && !commandIds.has(event.commandId)) {
            throw new SessionRuntimeError("invalid_export", "An exported event references a missing command");
        }
    }

    const activities: ImportedActivity[] = [];
    const toolCallKeys = new Set<string>();
    for (const value of activityValues) {
        const eventSequence =
            isRecord(value) &&
            typeof value["eventSequence"] === "string" &&
            DECIMAL_SEQUENCE_PATTERN.test(value["eventSequence"])
                ? Number(value["eventSequence"])
                : Number.NaN;
        if (
            !isRecord(value) ||
            !hasExactKeys(value, ["attemptId", "event", "eventSequence"]) ||
            !Number.isSafeInteger(eventSequence) ||
            eventSequence < 1 ||
            eventSequence >= nextSequenceNumber
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported activity is invalid");
        }
        const attemptId = importIdentifier(value, "attemptId");
        let event: RecordedSessionEvent;
        try {
            event = decodeRecordedSessionEvent(JSON.stringify(value["event"]));
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An exported activity is invalid", { cause });
        }
        const toolCallKey = `${attemptId}\u0000${event.kind === AGENT_ACTIVITY_KIND ? event.activityId : ""}`;
        if (
            event.kind !== AGENT_ACTIVITY_KIND ||
            event.sessionId !== sessionId ||
            event.detail.kind === "recorded" ||
            !commandIds.has(event.commandId) ||
            attemptIdsByCommand.get(event.commandId) !== attemptId ||
            toolCallKeys.has(toolCallKey)
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported activity is invalid");
        }
        const retainedEvent = decodedEvents.get(eventSequence);
        if (
            retainedEvent !== undefined &&
            (retainedEvent.kind !== AGENT_ACTIVITY_KIND || retainedEvent.activityId !== event.activityId)
        ) {
            throw new SessionRuntimeError("invalid_export", "An exported activity does not match its retained event");
        }
        toolCallKeys.add(toolCallKey);
        activities.push({
            attemptId,
            event,
            eventSequence,
        });
    }

    const artifacts = new Map<
        string,
        {
            readonly attemptId: string;
            readonly payload: string;
            readonly toolCallId: string;
        }
    >();
    let artifactBytes = 0;
    for (const value of artifactValues) {
        if (
            !isRecord(value) ||
            !hasExactKeys(value, [
                "attemptId",
                "artifactId",
                "byteLength",
                "contentBase64",
                "contentEncoding",
                "mediaType",
                "sha256",
                "toolCallId",
            ])
        ) {
            throw new SessionRuntimeError("invalid_export", "An export artifact is invalid");
        }
        const attemptId = importIdentifier(value, "attemptId");
        const toolCallId = importIdentifier(value, "toolCallId");
        const artifactId = importIdentifier(value, "artifactId");
        const mediaType = importString(value, "mediaType", 128);
        const contentBase64 = importString(value, "contentBase64", MAX_EXPORT_BYTE_LENGTH * 2, true);
        const expectedHash = importString(value, "sha256", 64);
        const byteLength = value["byteLength"];
        if (
            mediaType !== "application/json" ||
            value["contentEncoding"] !== "identity" ||
            typeof byteLength !== "number" ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            artifacts.has(artifactId) ||
            !toolCallKeys.has(`${attemptId}\u0000${toolCallId}`)
        ) {
            throw new SessionRuntimeError("invalid_export", "An export artifact is invalid");
        }
        let bytes: Uint8Array;
        let payload: string;
        try {
            bytes = decodeBase64(contentBase64);
            payload = new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
            }).decode(bytes);
            decodeActivityDetailPayload(payload, "invalid_export", "An export artifact is invalid");
        } catch (cause) {
            if (cause instanceof SessionRuntimeError && cause.code === "invalid_export") {
                throw cause;
            }
            throw new SessionRuntimeError("invalid_export", "An export artifact is invalid", { cause });
        }
        artifactBytes += bytes.byteLength;
        if (
            bytes.byteLength !== byteLength ||
            bytes.byteLength > contentLimitBytes ||
            artifactBytes > MAX_EXPORT_BYTE_LENGTH ||
            !/^[a-f0-9]{64}$/.test(expectedHash) ||
            (await sha256(bytes)) !== expectedHash
        ) {
            throw new SessionRuntimeError("invalid_export", "An export artifact is invalid");
        }
        artifacts.set(artifactId, { attemptId, payload, toolCallId });
    }
    const referencedArtifacts = new Set<string>();
    for (const activity of activities) {
        if (activity.event.detail.kind !== "available") {
            continue;
        }
        const artifact = artifacts.get(activity.event.detail.artifactId);
        if (artifact?.attemptId !== activity.attemptId || artifact.toolCallId !== activity.event.activityId) {
            throw new SessionRuntimeError("invalid_export", "An activity archive is missing from the export");
        }
        referencedArtifacts.add(activity.event.detail.artifactId);
    }
    if ([...artifacts.keys()].some((artifactId) => !referencedArtifacts.has(artifactId))) {
        throw new SessionRuntimeError("invalid_export", "The session export contains an unreferenced artifact");
    }

    const uploadedArtifacts: ArtifactContent[] = [];
    const uploadedArtifactsById = new Map<string, ArtifactContent>();
    for (const value of uploadedArtifactValues) {
        if (
            !isRecord(value) ||
            !hasExactKeys(value, [
                "artifactId",
                "availableAt",
                "byteLength",
                "contentBase64",
                "contentEncoding",
                "createdAt",
                "mediaType",
                "name",
                "sha256",
            ])
        ) {
            throw new SessionRuntimeError("invalid_export", "An uploaded export artifact is invalid");
        }
        const artifactId = importIdentifier(value, "artifactId");
        const availableAt = importTimestamp(value, "availableAt");
        const createdAt = importTimestamp(value, "createdAt");
        const byteLength = value["byteLength"];
        const mediaType = importString(value, "mediaType", 255);
        const name = importString(value, "name", 500);
        const expectedHash = importString(value, "sha256", 64);
        const contentBase64 = importString(value, "contentBase64", MAX_EXPORT_BYTE_LENGTH * 2, true);
        let bytes: Uint8Array;
        try {
            bytes = decodeBase64(contentBase64);
        } catch (cause) {
            throw new SessionRuntimeError("invalid_export", "An uploaded export artifact is invalid", { cause });
        }
        artifactBytes += bytes.byteLength;
        if (
            value["contentEncoding"] !== "identity" ||
            typeof byteLength !== "number" ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 1 ||
            byteLength > contentLimitBytes ||
            bytes.byteLength !== byteLength ||
            artifactBytes > MAX_EXPORT_BYTE_LENGTH ||
            availableAt < createdAt ||
            !/^[a-f0-9]{64}$/.test(expectedHash) ||
            (await sha256(bytes)) !== expectedHash ||
            uploadedArtifactsById.has(artifactId)
        ) {
            throw new SessionRuntimeError("invalid_export", "An uploaded export artifact is invalid");
        }
        const content = new ArtifactContent(
            new AvailableArtifactDescriptor(
                sessionId,
                artifactId,
                name,
                mediaType,
                byteLength,
                expectedHash,
                new Date(createdAt).toISOString(),
                new Date(availableAt).toISOString(),
            ),
            bytes,
        );
        uploadedArtifacts.push(content);
        uploadedArtifactsById.set(artifactId, content);
    }
    for (const command of commands) {
        for (const resource of command.command.resources) {
            if (resource.type !== "link" || !resource.uri.startsWith("mobius-artifact:")) {
                continue;
            }
            let uri: URL;
            try {
                uri = new URL(resource.uri);
            } catch (cause) {
                throw new SessionRuntimeError("invalid_export", "An uploaded artifact reference is invalid", { cause });
            }
            const content = uploadedArtifactsById.get(uri.pathname);
            if (
                content === undefined ||
                resource.name !== content.artifact.name ||
                resource.mimeType !== content.artifact.mediaType ||
                resource.text.length !== 0 ||
                uri.searchParams.size !== 2 ||
                uri.searchParams.get("byteLength") !== content.artifact.byteLength.toString() ||
                uri.searchParams.get("sha256") !== content.artifact.sha256
            ) {
                throw new SessionRuntimeError("invalid_export", "An uploaded artifact reference is invalid");
            }
        }
    }

    signal.throwIfAborted();
    return {
        activities,
        agentId,
        artifacts,
        bindingId,
        bindings,
        commands,
        contentLimitBytes,
        createdBy,
        directoryId,
        eventPayloadHashes,
        events,
        hotEventLimit,
        idempotencyRetentionMilliseconds,
        interactions,
        level,
        minimumSequenceNumber,
        nativeHistory,
        nextSequenceNumber,
        retentionMilliseconds,
        runtimeId,
        sessionId,
        title,
        uploadedArtifacts,
    };
}
