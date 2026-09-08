import { z } from "zod";

import { ProtocolMessageError } from "./codecs/messages.ts";
import { elicitationFieldSchema, permissionOptionSchema } from "./control-messages.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const identifierSchema = z.string().min(1).max(128).regex(IDENTIFIER_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const decimalSequenceSchema = z.string().min(1).max(40).regex(DECIMAL_SEQUENCE_PATTERN);
const digestSchema = z.string().length(64).regex(SHA256_PATTERN);

const recordingPolicySchema = z
    .strictObject({
        contentLimitBytes: z.number().int().positive().safe(),
        hotEventLimit: z.number().int().positive().safe(),
        idempotencyRetentionMilliseconds: z.number().int().positive().safe(),
        level: z.enum(["full", "summary"]),
        retentionMilliseconds: z.number().int().positive().safe(),
    })
    .readonly();

export type RecordingPolicy = z.infer<typeof recordingPolicySchema>;

const tenantLifecycleSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("active") }).readonly(),
    z
        .strictObject({
            kind: z.literal("suspended"),
            suspendedAt: timestampSchema,
        })
        .readonly(),
    z.strictObject({ deletedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

const tenantSchema = z
    .strictObject({
        lifecycle: tenantLifecycleSchema,
        quotaPolicyRevision: z.number().int().nonnegative().safe(),
        recordingPolicy: recordingPolicySchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type Tenant = z.infer<typeof tenantSchema>;

const projectLifecycleSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("active") }).readonly(),
    z.strictObject({ archivedAt: timestampSchema, kind: z.literal("archived") }).readonly(),
    z.strictObject({ deletedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

const projectSchema = z
    .strictObject({
        displayName: z.string().min(1).max(120),
        lifecycle: projectLifecycleSchema,
        projectId: identifierSchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type Project = z.infer<typeof projectSchema>;

const runtimeLifecycleSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("registered") }).readonly(),
    z.strictObject({ disabledAt: timestampSchema, kind: z.literal("disabled") }).readonly(),
    z.strictObject({ deletedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

const runtimeCapabilitySchema = z
    .strictObject({
        name: identifierSchema,
        revision: z.number().int().nonnegative().safe(),
    })
    .readonly();

const runtimeSchema = z
    .strictObject({
        capabilities: z.array(runtimeCapabilitySchema).max(100).readonly(),
        displayName: z.string().min(1).max(120),
        lifecycle: runtimeLifecycleSchema,
        runtimeId: identifierSchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type Runtime = z.infer<typeof runtimeSchema>;

const channelStateSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            connectionEpoch: z.number().int().nonnegative().safe(),
            connectedAt: timestampSchema,
            connectionId: identifierSchema,
            kind: z.literal("online"),
        })
        .readonly(),
    z
        .strictObject({
            connectionEpoch: z.number().int().nonnegative().safe(),
            disconnectedAt: timestampSchema,
            kind: z.literal("offline"),
        })
        .readonly(),
]);

const channelSchema = z
    .strictObject({
        channelId: identifierSchema,
        runtimeId: identifierSchema,
        state: channelStateSchema,
    })
    .readonly();

export type Channel = z.infer<typeof channelSchema>;

const sessionLifecycleSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ready") }).readonly(),
    z.strictObject({ kind: z.literal("deleting"), requestedAt: timestampSchema }).readonly(),
    z.strictObject({ completedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;

const sessionSchema = z
    .strictObject({
        createdAt: timestampSchema,
        createdBy: identifierSchema,
        defaultBindingId: identifierSchema,
        lastCommittedSeq: decimalSequenceSchema,
        lifecycle: sessionLifecycleSchema,
        projectId: identifierSchema,
        sessionId: identifierSchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type Session = z.infer<typeof sessionSchema>;

const sessionBindingSchema = z
    .strictObject({
        agentRef: identifierSchema,
        bindingId: identifierSchema,
        configRevision: z.number().int().nonnegative().safe(),
        createdAt: timestampSchema,
        runtimeId: identifierSchema,
        sessionId: identifierSchema,
        workspaceRef: identifierSchema,
    })
    .readonly();

export type SessionBinding = z.infer<typeof sessionBindingSchema>;

const domainErrorSchema = z
    .strictObject({
        code: identifierSchema,
        message: z.string().min(1).max(2_000),
        retryable: z.boolean(),
    })
    .readonly();

export type DomainError = z.infer<typeof domainErrorSchema>;

const executionResultSchema = z
    .strictObject({
        kind: z.literal("agent_result"),
        stopReason: z.string().min(1).max(128),
    })
    .readonly();

export type ExecutionResult = z.infer<typeof executionResultSchema>;

const reconciliationSchema = z
    .strictObject({
        detectedAt: timestampSchema,
        reason: z.enum(["connection_lost", "dispatch_indeterminate", "runtime_restarted"]),
    })
    .readonly();

export type Reconciliation = z.infer<typeof reconciliationSchema>;

const turnStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("queued") }).readonly(),
    z.strictObject({ kind: z.literal("running"), startedAt: timestampSchema }).readonly(),
    z
        .strictObject({
            completedAt: timestampSchema,
            kind: z.literal("succeeded"),
            result: executionResultSchema,
        })
        .readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
        })
        .readonly(),
    z
        .strictObject({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
        })
        .readonly(),
    z
        .strictObject({
            kind: z.literal("indeterminate"),
            reconciliation: reconciliationSchema,
        })
        .readonly(),
]);

export type TurnState = z.infer<typeof turnStateSchema>;

const turnRequestSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            content: z.string().max(100_000),
            kind: z.literal("prompt"),
        })
        .readonly(),
]);

export type TurnRequest = z.infer<typeof turnRequestSchema>;

const turnSchema = z
    .strictObject({
        acceptedAt: timestampSchema,
        bindingId: identifierSchema,
        idempotencyKey: identifierSchema,
        request: turnRequestSchema,
        sessionId: identifierSchema,
        state: turnStateSchema,
        turnId: identifierSchema,
    })
    .readonly();

export type Turn = z.infer<typeof turnSchema>;

const attemptStateSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            dispatchedAt: timestampSchema,
            kind: z.literal("dispatching"),
        })
        .readonly(),
    z.strictObject({ kind: z.literal("running"), startedAt: timestampSchema }).readonly(),
    z
        .strictObject({
            interactionIds: z.array(identifierSchema).min(1).max(100).readonly(),
            kind: z.literal("waiting_input"),
            startedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            completedAt: timestampSchema,
            kind: z.literal("succeeded"),
            result: executionResultSchema,
            startedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
            startedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
            startedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            kind: z.literal("indeterminate"),
            reconciliation: reconciliationSchema,
            startedAt: timestampSchema,
        })
        .readonly(),
]);

export type AttemptState = z.infer<typeof attemptStateSchema>;

const attemptSchema = z
    .strictObject({
        attemptId: identifierSchema,
        bindingId: identifierSchema,
        sessionId: identifierSchema,
        state: attemptStateSchema,
        turnId: identifierSchema,
    })
    .readonly();

export type Attempt = z.infer<typeof attemptSchema>;

const permissionRequestSchema = z
    .strictObject({
        kind: z.literal("permission"),
        options: z.array(permissionOptionSchema).min(1).max(20).readonly(),
        title: z.string().min(1).max(500),
        toolCallId: z.string().min(1).max(255),
        toolKind: z.string().max(64),
    })
    .readonly();

const elicitationRequestSchema = z
    .strictObject({
        elicitationId: z.string().max(255),
        fields: z.array(elicitationFieldSchema).max(100).readonly(),
        kind: z.literal("elicitation"),
        message: z.string().min(1).max(2_000),
        mode: z.enum(["form", "url"]),
        url: z.string().max(4_096),
    })
    .readonly();

const interactionRequestSchema = z.discriminatedUnion("kind", [permissionRequestSchema, elicitationRequestSchema]);

export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

const interactionResponseSchema = z
    .strictObject({
        content: z.string().max(100_000),
        kind: z.enum(["permission", "elicitation"]),
    })
    .readonly();

export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

const interactionStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }).readonly(),
    z
        .strictObject({
            kind: z.literal("responded"),
            respondedAt: timestampSchema,
            responderId: identifierSchema,
            response: interactionResponseSchema,
        })
        .readonly(),
    z
        .strictObject({
            kind: z.literal("resolved"),
            resolution: z.discriminatedUnion("kind", [
                z.strictObject({ kind: z.literal("without_response") }).readonly(),
                z
                    .strictObject({
                        kind: z.literal("response_applied"),
                        respondedAt: timestampSchema,
                        responderId: identifierSchema,
                        response: interactionResponseSchema,
                    })
                    .readonly(),
            ]),
            resolvedAt: timestampSchema,
        })
        .readonly(),
    z.strictObject({ expiredAt: timestampSchema, kind: z.literal("expired") }).readonly(),
    z
        .strictObject({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
        })
        .readonly(),
]);

export type InteractionState = z.infer<typeof interactionStateSchema>;

const interactionSchema = z
    .strictObject({
        attemptId: identifierSchema,
        interactionId: identifierSchema,
        request: interactionRequestSchema,
        sessionId: identifierSchema,
        state: interactionStateSchema,
        turnId: identifierSchema,
    })
    .readonly();

export type Interaction = z.infer<typeof interactionSchema>;

const recordingCompletenessSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("complete") }).readonly(),
    z
        .strictObject({
            capturedBytes: z.number().int().nonnegative().safe(),
            kind: z.literal("truncated"),
            originalBytes: z.number().int().positive().safe(),
        })
        .readonly(),
    z.strictObject({ kind: z.literal("redacted"), reason: identifierSchema }).readonly(),
    z.strictObject({ kind: z.literal("uncaptured") }).readonly(),
]);

export type RecordingCompleteness = z.infer<typeof recordingCompletenessSchema>;

const messageViewStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("building") }).readonly(),
    z
        .strictObject({
            completeness: recordingCompletenessSchema,
            kind: z.literal("available"),
        })
        .readonly(),
    z.strictObject({ deletedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

const messageViewCommon = {
    contentArtifactIds: z.array(identifierSchema).max(100).readonly(),
    lastAppliedSeq: decimalSequenceSchema,
    messageId: identifierSchema,
    preview: z.string().max(4_000),
    sessionId: identifierSchema,
    state: messageViewStateSchema,
};

const messageViewSchema = z.discriminatedUnion("role", [
    z
        .strictObject({
            ...messageViewCommon,
            role: z.literal("user"),
            source: z.strictObject({ kind: z.literal("turn"), turnId: identifierSchema }).readonly(),
        })
        .readonly(),
    z
        .strictObject({
            ...messageViewCommon,
            role: z.literal("agent"),
            source: z
                .strictObject({
                    attemptId: identifierSchema,
                    kind: z.literal("attempt"),
                    turnId: identifierSchema,
                })
                .readonly(),
        })
        .readonly(),
    z
        .strictObject({
            ...messageViewCommon,
            role: z.literal("tool"),
            source: z
                .strictObject({
                    attemptId: identifierSchema,
                    kind: z.literal("tool_call"),
                    toolCallId: identifierSchema,
                    turnId: identifierSchema,
                })
                .readonly(),
        })
        .readonly(),
    z
        .strictObject({
            ...messageViewCommon,
            role: z.literal("system"),
            source: z.strictObject({ kind: z.literal("system") }).readonly(),
        })
        .readonly(),
]);

export type MessageView = z.infer<typeof messageViewSchema>;

const toolCallDetailSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            artifactId: identifierSchema,
            kind: z.literal("available"),
        })
        .readonly(),
    z
        .strictObject({
            capturedBytes: z.number().int().nonnegative().safe(),
            kind: z.literal("truncated"),
            originalBytes: z.number().int().positive().safe(),
        })
        .readonly(),
    z.strictObject({ kind: z.literal("uncaptured") }).readonly(),
    z.strictObject({ deletedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

const toolCallViewStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }).readonly(),
    z.strictObject({ kind: z.literal("running"), startedAt: timestampSchema }).readonly(),
    z
        .strictObject({
            completedAt: timestampSchema,
            kind: z.literal("succeeded"),
        })
        .readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
        })
        .readonly(),
    z
        .strictObject({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
        })
        .readonly(),
]);

const toolCallViewSchema = z
    .strictObject({
        attemptId: identifierSchema,
        detail: toolCallDetailSchema,
        inputPreview: z.string().max(4_000),
        lastAppliedSeq: decimalSequenceSchema,
        name: z.string().max(128),
        outputPreview: z.string().max(4_000),
        state: toolCallViewStateSchema,
        title: z.string().min(1).max(500),
        toolCallId: identifierSchema,
        toolKind: identifierSchema,
    })
    .readonly();

export type ToolCallView = z.infer<typeof toolCallViewSchema>;

const sessionListEntrySchema = z
    .strictObject({
        lastAppliedSeq: decimalSequenceSchema,
        preview: z.string().max(4_000),
        projectId: identifierSchema,
        projectedAttemptState: z.enum(["idle", "dispatching", "running", "waiting_input", "indeterminate"]),
        sessionId: identifierSchema,
        tenantId: identifierSchema,
        title: z.string().max(500),
        updatedAt: timestampSchema,
    })
    .readonly();

export type SessionListEntry = z.infer<typeof sessionListEntrySchema>;

const artifactStateSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            expectedBytes: z.number().int().nonnegative().safe(),
            expiresAt: timestampSchema,
            kind: z.literal("uploading"),
            uploadId: identifierSchema,
        })
        .readonly(),
    z
        .strictObject({
            availableAt: timestampSchema,
            byteLength: z.number().int().nonnegative().safe(),
            kind: z.literal("available"),
            sha256: digestSchema,
        })
        .readonly(),
    z.strictObject({ kind: z.literal("deleting"), requestedAt: timestampSchema }).readonly(),
    z.strictObject({ completedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
        })
        .readonly(),
    z.strictObject({ expiredAt: timestampSchema, kind: z.literal("expired") }).readonly(),
]);

export type ArtifactState = z.infer<typeof artifactStateSchema>;

const artifactSchema = z
    .strictObject({
        artifactId: identifierSchema,
        completeness: recordingCompletenessSchema,
        contentKind: identifierSchema,
        mediaType: z.string().min(1).max(128),
        projectId: identifierSchema,
        provenance: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("user_upload") }).readonly(),
            z
                .strictObject({
                    attemptId: identifierSchema,
                    kind: z.literal("tool_call"),
                    toolCallId: identifierSchema,
                    turnId: identifierSchema,
                })
                .readonly(),
            z
                .strictObject({
                    attemptId: identifierSchema,
                    kind: z.literal("agent_generated"),
                    turnId: identifierSchema,
                })
                .readonly(),
        ]),
        sessionId: identifierSchema,
        state: artifactStateSchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type Artifact = z.infer<typeof artifactSchema>;

const archiveSegmentStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending"), queuedAt: timestampSchema }).readonly(),
    z
        .strictObject({
            byteLength: z.number().int().nonnegative().safe(),
            kind: z.literal("uploaded"),
            sha256: digestSchema,
            uploadedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            byteLength: z.number().int().nonnegative().safe(),
            kind: z.literal("published"),
            publishedAt: timestampSchema,
            sha256: digestSchema,
        })
        .readonly(),
    z.strictObject({ kind: z.literal("deleting"), requestedAt: timestampSchema }).readonly(),
    z.strictObject({ completedAt: timestampSchema, kind: z.literal("deleted") }).readonly(),
]);

export type ArchiveSegmentState = z.infer<typeof archiveSegmentStateSchema>;

const archiveSegmentSchema = z
    .strictObject({
        compression: z.literal("gzip"),
        eventCount: z.number().int().positive().safe(),
        firstSeq: decimalSequenceSchema,
        lastSeq: decimalSequenceSchema,
        segmentId: identifierSchema,
        sessionId: identifierSchema,
        state: archiveSegmentStateSchema,
    })
    .readonly();

export type ArchiveSegment = z.infer<typeof archiveSegmentSchema>;

const pendingWorkStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending"), queuedAt: timestampSchema }).readonly(),
    z
        .strictObject({
            attempt: z.number().int().positive().safe(),
            kind: z.literal("running"),
            startedAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            completedAt: timestampSchema,
            kind: z.literal("completed"),
        })
        .readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            kind: z.literal("retryable"),
            nextAttemptAt: timestampSchema,
        })
        .readonly(),
    z
        .strictObject({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
        })
        .readonly(),
]);

const pendingWorkSchema = z
    .strictObject({
        kind: z.enum(["archive", "delete", "dispatch", "interaction_response", "projection"]),
        projectId: identifierSchema,
        sessionId: identifierSchema,
        state: pendingWorkStateSchema,
        tenantId: identifierSchema,
        workId: identifierSchema,
    })
    .readonly();

export type PendingWork = z.infer<typeof pendingWorkSchema>;

const commandReceiptSchema = z
    .strictObject({
        acceptedAt: timestampSchema,
        commandKind: identifierSchema,
        expiresAt: timestampSchema,
        idempotencyKey: identifierSchema,
        projectId: identifierSchema,
        requestHash: digestSchema,
        resultId: identifierSchema,
        sessionId: identifierSchema,
        tenantId: identifierSchema,
    })
    .readonly();

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export class ResourceTransitionError extends Error {
    readonly code = "invalid_resource_transition";

    constructor(resource: string, from: string, to: string) {
        super(`Invalid ${resource} transition from ${from} to ${to}`);
        this.name = "ResourceTransitionError";
    }
}

function canTransitionSession(from: SessionLifecycle["kind"], to: SessionLifecycle["kind"]): boolean {
    switch (from) {
        case "ready":
            return to === "deleting";
        case "deleting":
            return to === "deleted";
        case "deleted":
            return false;
    }
}

function canTransitionTurn(from: TurnState["kind"], to: TurnState["kind"]): boolean {
    switch (from) {
        case "queued":
            return to === "running" || to === "failed" || to === "cancelled";
        case "running":
            return to === "succeeded" || to === "failed" || to === "cancelled" || to === "indeterminate";
        case "indeterminate":
            return to === "running" || to === "succeeded" || to === "failed" || to === "cancelled";
        case "succeeded":
        case "failed":
        case "cancelled":
            return false;
    }
}

function canTransitionAttempt(from: AttemptState["kind"], to: AttemptState["kind"]): boolean {
    switch (from) {
        case "dispatching":
            return to === "running" || to === "failed" || to === "cancelled" || to === "indeterminate";
        case "running":
            return (
                to === "waiting_input" ||
                to === "succeeded" ||
                to === "failed" ||
                to === "cancelled" ||
                to === "indeterminate"
            );
        case "waiting_input":
            return (
                to === "running" ||
                to === "succeeded" ||
                to === "failed" ||
                to === "cancelled" ||
                to === "indeterminate"
            );
        case "indeterminate":
            return to === "running" || to === "succeeded" || to === "failed" || to === "cancelled";
        case "succeeded":
        case "failed":
        case "cancelled":
            return false;
    }
}

function canTransitionInteraction(from: InteractionState["kind"], to: InteractionState["kind"]): boolean {
    switch (from) {
        case "pending":
            return to === "responded" || to === "resolved" || to === "expired" || to === "cancelled";
        case "responded":
            return to === "resolved" || to === "expired" || to === "cancelled";
        case "resolved":
        case "expired":
        case "cancelled":
            return false;
    }
}

export function transitionSession(session: Session, lifecycle: SessionLifecycle): Session {
    if (!canTransitionSession(session.lifecycle.kind, lifecycle.kind)) {
        throw new ResourceTransitionError("Session", session.lifecycle.kind, lifecycle.kind);
    }
    return { ...session, lifecycle };
}

export function transitionTurn(turn: Turn, state: TurnState): Turn {
    if (!canTransitionTurn(turn.state.kind, state.kind)) {
        throw new ResourceTransitionError("Turn", turn.state.kind, state.kind);
    }
    return { ...turn, state };
}

export function transitionAttempt(attempt: Attempt, state: AttemptState): Attempt {
    if (!canTransitionAttempt(attempt.state.kind, state.kind)) {
        throw new ResourceTransitionError("Attempt", attempt.state.kind, state.kind);
    }
    return { ...attempt, state };
}

export function transitionInteraction(interaction: Interaction, state: InteractionState): Interaction {
    if (!canTransitionInteraction(interaction.state.kind, state.kind)) {
        throw new ResourceTransitionError("Interaction", interaction.state.kind, state.kind);
    }
    return { ...interaction, state };
}

function decodeResource<T>(value: unknown, schema: z.ZodType<T>): T {
    const decoded = schema.safeParse(value);
    if (!decoded.success) {
        throw new ProtocolMessageError("Resource does not match its schema", {
            cause: decoded.error,
        });
    }
    return decoded.data;
}

export const decodeTenant = (value: unknown): Tenant => decodeResource(value, tenantSchema);
export const decodeProject = (value: unknown): Project => decodeResource(value, projectSchema);
export const decodeRuntime = (value: unknown): Runtime => decodeResource(value, runtimeSchema);
export const decodeChannel = (value: unknown): Channel => decodeResource(value, channelSchema);
export const decodeSession = (value: unknown): Session => decodeResource(value, sessionSchema);
export const decodeSessionBinding = (value: unknown): SessionBinding => decodeResource(value, sessionBindingSchema);
export const decodeTurn = (value: unknown): Turn => decodeResource(value, turnSchema);
export const decodeAttempt = (value: unknown): Attempt => decodeResource(value, attemptSchema);
export const decodeInteraction = (value: unknown): Interaction => decodeResource(value, interactionSchema);
export const decodeInteractionRequest = (value: unknown): InteractionRequest =>
    decodeResource(value, interactionRequestSchema);
export const decodeInteractionResponse = (value: unknown): InteractionResponse =>
    decodeResource(value, interactionResponseSchema);
export const decodeMessageView = (value: unknown): MessageView => decodeResource(value, messageViewSchema);
export const decodeToolCallView = (value: unknown): ToolCallView => decodeResource(value, toolCallViewSchema);
export const decodeSessionListEntry = (value: unknown): SessionListEntry =>
    decodeResource(value, sessionListEntrySchema);
export const decodeArtifact = (value: unknown): Artifact => decodeResource(value, artifactSchema);
export const decodeArchiveSegment = (value: unknown): ArchiveSegment => decodeResource(value, archiveSegmentSchema);
export const decodePendingWork = (value: unknown): PendingWork => decodeResource(value, pendingWorkSchema);
export const decodeCommandReceipt = (value: unknown): CommandReceipt => decodeResource(value, commandReceiptSchema);
