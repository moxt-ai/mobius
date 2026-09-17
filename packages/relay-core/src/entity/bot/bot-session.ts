import type {
    AgentExecutionConfiguration,
    BotCompletionDeliveryPolicy,
    BotDeliveryTargetReference,
    BotReplyRoute,
    PromptImage,
    PromptResource,
    SessionConfigurationSelection,
} from "@moxt-ai/mobius-protocol";
import type { OperationTiming } from "../../infra/operation-timing.ts";
import type { ExecutionPermit } from "../authentication/project-authentication.ts";
import {
    type ProjectScope,
    type SessionMessageContent,
    SessionRuntimeError,
    type SessionSummary,
} from "../do/session.ts";

export const BOT_EXECUTION_LIFETIME_MILLISECONDS = 30 * 60 * 1_000;
export const BOT_EXECUTION_OUTBOUND_USAGE_LIMIT = 16;
export const BOT_OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export class BotSessionProvisioning {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargets: readonly BotDeliveryTargetReference[];
    readonly behaviorDigest: string;
    readonly behaviorInstructions: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: BotCompletionDeliveryPolicy;
    readonly conversationId: string;
    readonly creatorKind: string;
    readonly creatorPrincipalId: string;
    readonly executionConfiguration: AgentExecutionConfiguration;
    readonly localGrantId: string;
    readonly replyRoute: BotReplyRoute;
    readonly runtimeId: string;
    readonly sessionConfigurations: readonly SessionConfigurationSelection[];
    readonly sessionId: string;
    readonly title: string;
    readonly workspaceRef: string;

    constructor(
        sessionId: string,
        conversationId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        localGrantId: string,
        creatorKind: string,
        creatorPrincipalId: string,
        title: string,
        behaviorInstructions: string,
        behaviorDigest: string,
        allowedDeliveryTargets: readonly BotDeliveryTargetReference[],
        completionPolicy: BotCompletionDeliveryPolicy,
        replyRoute: BotReplyRoute,
        executionConfiguration: AgentExecutionConfiguration,
        sessionConfigurations: readonly SessionConfigurationSelection[] = [],
    ) {
        this.sessionId = sessionId;
        this.conversationId = conversationId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.agentRef = agentRef;
        this.workspaceRef = workspaceRef;
        this.agentConfigRevision = agentConfigRevision;
        this.localGrantId = localGrantId;
        this.creatorKind = creatorKind;
        this.creatorPrincipalId = creatorPrincipalId;
        this.title = title;
        this.behaviorInstructions = behaviorInstructions;
        this.behaviorDigest = behaviorDigest;
        this.allowedDeliveryTargets = Object.freeze([...allowedDeliveryTargets]);
        this.completionPolicy = completionPolicy;
        this.replyRoute = replyRoute;
        this.executionConfiguration = executionConfiguration;
        this.sessionConfigurations = Object.freeze([...sessionConfigurations]);
    }

    toJSON(): object {
        const { sessionConfigurations, ...provisioning } = this;
        return {
            ...provisioning,
            ...(sessionConfigurations.length === 0 ? {} : { sessionConfigurations }),
        };
    }
}

export class BotTurnSubmission {
    readonly actorRef: string;
    readonly additionalDirectoryIds: readonly string[];
    readonly clientMessageId: string;
    readonly disposition: string;
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
    readonly targetTurnId: string;

    constructor(
        clientMessageId: string,
        actorRef: string,
        prompt: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        disposition = "reject",
        targetTurnId = "",
    ) {
        this.clientMessageId = clientMessageId;
        this.actorRef = actorRef;
        this.prompt = prompt;
        this.additionalDirectoryIds = Object.freeze([...additionalDirectoryIds]);
        this.disposition = disposition;
        this.images = Object.freeze([...images]);
        this.resources = Object.freeze([...resources]);
        this.targetTurnId = targetTurnId;
    }
}

export class BotExecutionRecord {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly deadlineAt: string;
    readonly executionId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(
        executionId: string,
        capabilityId: string,
        botId: string,
        conversationId: string,
        sessionId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        runtimeId: string,
        deadlineAt: string,
    ) {
        this.executionId = executionId;
        this.capabilityId = capabilityId;
        this.botId = botId;
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.deadlineAt = deadlineAt;
    }
}

export class BotTurnAcceptance {
    readonly duplicate: boolean;
    readonly execution: BotExecutionRecord;

    constructor(execution: BotExecutionRecord, duplicate: boolean) {
        this.execution = execution;
        this.duplicate = duplicate;
    }
}

export class BotConversationEvent {
    readonly behaviorRevisionId: string;
    readonly conversationId: string;
    readonly eventId: string;
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly sequence: string;
    readonly timestamp: string;
    readonly turnId: string;

    constructor(
        eventId: string,
        conversationId: string,
        turnId: string,
        sequence: string,
        timestamp: string,
        behaviorRevisionId: string,
        kind: string,
        payload: Readonly<Record<string, unknown>>,
    ) {
        this.eventId = eventId;
        this.conversationId = conversationId;
        this.turnId = turnId;
        this.sequence = sequence;
        this.timestamp = timestamp;
        this.behaviorRevisionId = behaviorRevisionId;
        this.kind = kind;
        this.payload = Object.freeze({ ...payload });
    }
}

export class BotConversationEventPage {
    readonly cursor: string;
    readonly events: readonly BotConversationEvent[];
    readonly hasMore: boolean;

    constructor(cursor: string, events: readonly BotConversationEvent[], hasMore: boolean) {
        this.cursor = cursor;
        this.events = Object.freeze([...events]);
        this.hasMore = hasMore;
    }
}

export interface BotConversationMessage extends SessionMessageContent {
    readonly behaviorRevisionId: string;
    readonly clientMessageId: string;
    readonly executionId: string;
    readonly targetClientMessageId: string;
    readonly turnId: string;
}

export class BotConversationMessagePage {
    readonly conversationId: string;
    readonly lastCommittedSequence: string;
    readonly messages: readonly BotConversationMessage[];
    readonly nextCursor: string;
    readonly tailEventCursor: string;

    constructor(
        conversationId: string,
        messages: readonly BotConversationMessage[],
        nextCursor: string,
        lastCommittedSequence: string,
        tailEventCursor: string,
    ) {
        this.conversationId = conversationId;
        this.lastCommittedSequence = lastCommittedSequence;
        this.messages = Object.freeze([...messages]);
        this.nextCursor = nextCursor;
        this.tailEventCursor = tailEventCursor;
    }
}

export class BotOutboundSubmission {
    readonly deliveryTargetId: string;
    readonly idempotencyKey: string;
    readonly text: string;

    constructor(idempotencyKey: string, deliveryTargetId: string, text: string) {
        this.idempotencyKey = idempotencyKey;
        this.deliveryTargetId = deliveryTargetId;
        this.text = text;
    }
}

export class BotOutboundAcceptance {
    readonly acceptedAt: string;
    readonly behaviorRevisionId: string;
    readonly bindingRevision: number;
    readonly bindingId: string;
    readonly botId: string;
    readonly conversationId: string;
    readonly deliveryTargetId: string;
    readonly duplicate: boolean;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly outboundMessageId: string;
    readonly text: string;
    readonly turnId: string;

    constructor(
        outboundMessageId: string,
        botId: string,
        conversationId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        executionId: string,
        deliveryTargetId: string,
        idempotencyKey: string,
        text: string,
        acceptedAt: string,
        expiresAt: string,
        duplicate: boolean,
    ) {
        this.outboundMessageId = outboundMessageId;
        this.botId = botId;
        this.conversationId = conversationId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.executionId = executionId;
        this.deliveryTargetId = deliveryTargetId;
        this.idempotencyKey = idempotencyKey;
        this.text = text;
        this.acceptedAt = acceptedAt;
        this.expiresAt = expiresAt;
        this.duplicate = duplicate;
    }
}

export class PendingBotOutbound {
    readonly acceptedAt: string;
    readonly behaviorRevisionId: string;
    readonly bindingRevision: number;
    readonly bindingId: string;
    readonly botId: string;
    readonly conversationId: string;
    readonly deliveryTargetId: string;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly outboundMessageId: string;
    readonly text: string;
    readonly turnId: string;

    constructor(
        outboundMessageId: string,
        botId: string,
        conversationId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        executionId: string,
        deliveryTargetId: string,
        idempotencyKey: string,
        text: string,
        acceptedAt: string,
        expiresAt: string,
    ) {
        this.outboundMessageId = outboundMessageId;
        this.botId = botId;
        this.conversationId = conversationId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.executionId = executionId;
        this.deliveryTargetId = deliveryTargetId;
        this.idempotencyKey = idempotencyKey;
        this.text = text;
        this.acceptedAt = acceptedAt;
        this.expiresAt = expiresAt;
    }
}

export class BotSessionRuntimeError extends SessionRuntimeError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "BotSessionRuntimeError";
    }
}

export interface BotSessionRuntime {
    readonly authorizeExecutionCapability: (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<ExecutionPermit>;
    readonly acceptOutbound: (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        submission: BotOutboundSubmission,
        now: number,
        signal: AbortSignal,
    ) => Promise<BotOutboundAcceptance>;
    readonly acceptTurn: (
        scope: ProjectScope,
        sessionId: string,
        submission: BotTurnSubmission,
        now: number,
        signal: AbortSignal,
    ) => Promise<BotTurnAcceptance>;
    readonly listPendingOutbound: (
        scope: ProjectScope,
        sessionId: string,
        limit: number,
        now: number,
        signal: AbortSignal,
    ) => Promise<readonly PendingBotOutbound[]>;
    readonly promoteQueuedTurnToSteering: (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<BotExecutionRecord>;
    readonly readConversationEvents: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<BotConversationEventPage>;
    readonly readConversationMessages: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        signal: AbortSignal,
    ) => Promise<BotConversationMessagePage>;
    readonly markOutboundForwarded: (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly markOutboundTerminalFailure: (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        failureCode: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly provisionConversation: (
        scope: ProjectScope,
        provisioning: BotSessionProvisioning,
        now: number,
        signal: AbortSignal,
        timing: OperationTiming,
    ) => Promise<SessionSummary>;
    readonly settleExecution: (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        outcome: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<readonly PendingBotOutbound[]>;
}
