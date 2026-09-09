import { ProtocolMessageError } from "./codecs/messages.ts";
import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    type PromptImage,
    type PromptResource,
} from "./control-messages.ts";

export const BOT_BINDING_APPROVAL_REQUEST_KIND = "bot.binding.approval.request";
export const BOT_BINDING_APPROVED_KIND = "bot.binding.approved";
export const BOT_BINDING_UNAVAILABLE_KIND = "bot.binding.unavailable";
export const BOT_SESSION_PROMPT_KIND = "bot.session.prompt";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INSTRUCTIONS_LENGTH = 100_000;

export abstract class BotResource {
    abstract readonly lifecycle: string;
    readonly botId: string;
    readonly projectId: string;
    readonly currentProfileRevisionId: string;
    readonly lifecycleRevision: number;
    readonly createdAt: string;
    readonly updatedAt: string;

    protected constructor(
        botId: string,
        projectId: string,
        currentProfileRevisionId: string,
        lifecycleRevision: number,
        createdAt: string,
        updatedAt: string,
    ) {
        this.botId = botId;
        this.projectId = projectId;
        this.currentProfileRevisionId = currentProfileRevisionId;
        this.lifecycleRevision = lifecycleRevision;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }
}

export class DraftBot extends BotResource {
    readonly lifecycle = "draft";

    constructor(
        botId: string,
        projectId: string,
        currentProfileRevisionId: string,
        lifecycleRevision: number,
        createdAt: string,
        updatedAt: string,
    ) {
        super(botId, projectId, currentProfileRevisionId, lifecycleRevision, createdAt, updatedAt);
    }
}

export class ActiveBot extends BotResource {
    readonly lifecycle = "active";
    readonly activeBehaviorRevisionId: string;
    readonly activeBindingId: string;

    constructor(
        botId: string,
        projectId: string,
        currentProfileRevisionId: string,
        activeBehaviorRevisionId: string,
        activeBindingId: string,
        lifecycleRevision: number,
        createdAt: string,
        updatedAt: string,
    ) {
        super(botId, projectId, currentProfileRevisionId, lifecycleRevision, createdAt, updatedAt);
        this.activeBehaviorRevisionId = activeBehaviorRevisionId;
        this.activeBindingId = activeBindingId;
    }
}

export class SuspendedBot extends BotResource {
    readonly lifecycle = "suspended";
    readonly activeBehaviorRevisionId: string;
    readonly activeBindingId: string;
    readonly suspendedAt: string;

    constructor(
        botId: string,
        projectId: string,
        currentProfileRevisionId: string,
        activeBehaviorRevisionId: string,
        activeBindingId: string,
        lifecycleRevision: number,
        createdAt: string,
        updatedAt: string,
        suspendedAt: string,
    ) {
        super(botId, projectId, currentProfileRevisionId, lifecycleRevision, createdAt, updatedAt);
        this.activeBehaviorRevisionId = activeBehaviorRevisionId;
        this.activeBindingId = activeBindingId;
        this.suspendedAt = suspendedAt;
    }
}

export class ArchivedBot extends BotResource {
    readonly lifecycle = "archived";
    readonly archivedAt: string;

    constructor(
        botId: string,
        projectId: string,
        currentProfileRevisionId: string,
        lifecycleRevision: number,
        createdAt: string,
        updatedAt: string,
        archivedAt: string,
    ) {
        super(botId, projectId, currentProfileRevisionId, lifecycleRevision, createdAt, updatedAt);
        this.archivedAt = archivedAt;
    }
}

export class BotProfileRevision {
    readonly avatarRef: string;
    readonly botId: string;
    readonly createdAt: string;
    readonly description: string;
    readonly displayName: string;
    readonly profileRevisionId: string;
    readonly revisionNumber: number;

    constructor(
        profileRevisionId: string,
        botId: string,
        revisionNumber: number,
        displayName: string,
        avatarRef: string,
        description: string,
        createdAt: string,
    ) {
        this.profileRevisionId = profileRevisionId;
        this.botId = botId;
        this.revisionNumber = revisionNumber;
        this.displayName = displayName;
        this.avatarRef = avatarRef;
        this.description = description;
        this.createdAt = createdAt;
    }
}

export abstract class BotBehaviorRevision {
    readonly agentConfiguration: Readonly<Record<string, unknown>>;
    readonly behaviorRevisionId: string;
    readonly botId: string;
    readonly contentDigest: string;
    readonly createdAt: string;
    readonly instructions: string;
    abstract readonly lifecycle: string;
    readonly requiredCapabilities: readonly string[];
    readonly revisionNumber: number;

    protected constructor(
        behaviorRevisionId: string,
        botId: string,
        revisionNumber: number,
        instructions: string,
        requiredCapabilities: readonly string[],
        agentConfiguration: Readonly<Record<string, unknown>>,
        contentDigest: string,
        createdAt: string,
    ) {
        this.behaviorRevisionId = behaviorRevisionId;
        this.botId = botId;
        this.revisionNumber = revisionNumber;
        this.instructions = instructions;
        this.requiredCapabilities = Object.freeze([...requiredCapabilities]);
        this.agentConfiguration = Object.freeze({ ...agentConfiguration });
        this.contentDigest = contentDigest;
        this.createdAt = createdAt;
    }
}

export class ProposedBotBehavior extends BotBehaviorRevision {
    readonly lifecycle = "proposed";

    constructor(
        behaviorRevisionId: string,
        botId: string,
        revisionNumber: number,
        instructions: string,
        requiredCapabilities: readonly string[],
        agentConfiguration: Readonly<Record<string, unknown>>,
        contentDigest: string,
        createdAt: string,
    ) {
        super(
            behaviorRevisionId,
            botId,
            revisionNumber,
            instructions,
            requiredCapabilities,
            agentConfiguration,
            contentDigest,
            createdAt,
        );
    }
}

export class AwaitingLocalApprovalBotBehavior extends BotBehaviorRevision {
    readonly lifecycle = "awaiting_local_approval";

    constructor(behavior: BotBehaviorRevision) {
        super(
            behavior.behaviorRevisionId,
            behavior.botId,
            behavior.revisionNumber,
            behavior.instructions,
            behavior.requiredCapabilities,
            behavior.agentConfiguration,
            behavior.contentDigest,
            behavior.createdAt,
        );
    }
}

export class ApprovedBotBehavior extends BotBehaviorRevision {
    readonly approvedAt: string;
    readonly lifecycle = "approved";

    constructor(behavior: BotBehaviorRevision, approvedAt: string) {
        super(
            behavior.behaviorRevisionId,
            behavior.botId,
            behavior.revisionNumber,
            behavior.instructions,
            behavior.requiredCapabilities,
            behavior.agentConfiguration,
            behavior.contentDigest,
            behavior.createdAt,
        );
        this.approvedAt = approvedAt;
    }
}

export class RetiredBotBehavior extends BotBehaviorRevision {
    readonly lifecycle = "retired";
    readonly retiredAt: string;

    constructor(behavior: BotBehaviorRevision, retiredAt: string) {
        super(
            behavior.behaviorRevisionId,
            behavior.botId,
            behavior.revisionNumber,
            behavior.instructions,
            behavior.requiredCapabilities,
            behavior.agentConfiguration,
            behavior.contentDigest,
            behavior.createdAt,
        );
        this.retiredAt = retiredAt;
    }
}

export abstract class BotExecutionBinding {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: BotCompletionDeliveryPolicy;
    readonly createdAt: string;
    abstract readonly lifecycle: string;
    readonly runtimeId: string;
    readonly workspaceRef: string;

    protected constructor(
        bindingId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingRevision: number,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        allowedDeliveryTargetIds: readonly string[],
        completionPolicy: BotCompletionDeliveryPolicy,
        createdAt: string,
    ) {
        this.bindingId = bindingId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.agentRef = agentRef;
        this.workspaceRef = workspaceRef;
        this.agentConfigRevision = agentConfigRevision;
        this.allowedDeliveryTargetIds = Object.freeze([...allowedDeliveryTargetIds]);
        this.completionPolicy = completionPolicy;
        this.createdAt = createdAt;
    }
}

export class RequestedBotExecutionBinding extends BotExecutionBinding {
    readonly lifecycle = "requested";

    constructor(
        bindingId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingRevision: number,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        allowedDeliveryTargetIds: readonly string[],
        completionPolicy: BotCompletionDeliveryPolicy,
        createdAt: string,
    ) {
        super(
            bindingId,
            botId,
            behaviorRevisionId,
            bindingRevision,
            runtimeId,
            agentRef,
            workspaceRef,
            agentConfigRevision,
            allowedDeliveryTargetIds,
            completionPolicy,
            createdAt,
        );
    }
}

export class ApprovedBotExecutionBinding extends BotExecutionBinding {
    readonly agentIdentityDigest: string;
    readonly approvedAt: string;
    readonly lifecycle = "approved";
    readonly localGrantId: string;
    readonly workspaceIdentityDigest: string;

    constructor(
        binding: BotExecutionBinding,
        localGrantId: string,
        agentIdentityDigest: string,
        workspaceIdentityDigest: string,
        approvedAt: string,
    ) {
        super(
            binding.bindingId,
            binding.botId,
            binding.behaviorRevisionId,
            binding.bindingRevision,
            binding.runtimeId,
            binding.agentRef,
            binding.workspaceRef,
            binding.agentConfigRevision,
            binding.allowedDeliveryTargetIds,
            binding.completionPolicy,
            binding.createdAt,
        );
        this.localGrantId = localGrantId;
        this.agentIdentityDigest = agentIdentityDigest;
        this.workspaceIdentityDigest = workspaceIdentityDigest;
        this.approvedAt = approvedAt;
    }
}

export class UnavailableBotExecutionBinding extends BotExecutionBinding {
    readonly code: string;
    readonly lifecycle = "unavailable";
    readonly message: string;
    readonly unavailableAt: string;

    constructor(binding: BotExecutionBinding, code: string, message: string, unavailableAt: string) {
        super(
            binding.bindingId,
            binding.botId,
            binding.behaviorRevisionId,
            binding.bindingRevision,
            binding.runtimeId,
            binding.agentRef,
            binding.workspaceRef,
            binding.agentConfigRevision,
            binding.allowedDeliveryTargetIds,
            binding.completionPolicy,
            binding.createdAt,
        );
        this.code = code;
        this.message = message;
        this.unavailableAt = unavailableAt;
    }
}

export class RevokedBotExecutionBinding extends BotExecutionBinding {
    readonly lifecycle = "revoked";
    readonly revokedAt: string;

    constructor(binding: BotExecutionBinding, revokedAt: string) {
        super(
            binding.bindingId,
            binding.botId,
            binding.behaviorRevisionId,
            binding.bindingRevision,
            binding.runtimeId,
            binding.agentRef,
            binding.workspaceRef,
            binding.agentConfigRevision,
            binding.allowedDeliveryTargetIds,
            binding.completionPolicy,
            binding.createdAt,
        );
        this.revokedAt = revokedAt;
    }
}

export class BotDeliveryTargetReference {
    readonly alias: string;
    readonly deliveryTargetId: string;

    constructor(alias: string, deliveryTargetId: string) {
        this.alias = alias;
        this.deliveryTargetId = deliveryTargetId;
    }
}

export abstract class BotDeliveryTarget {
    readonly alias: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly createdAt: string;
    readonly deliveryTargetId: string;
    abstract readonly lifecycle: string;
    readonly lifecycleRevision: number;
    readonly outboundPolicyRevision: number;
    readonly ownerApproved: boolean;

    protected constructor(
        deliveryTargetId: string,
        botId: string,
        connectionId: string,
        alias: string,
        outboundPolicyRevision: number,
        lifecycleRevision: number,
        ownerApproved: boolean,
        createdAt: string,
    ) {
        this.deliveryTargetId = deliveryTargetId;
        this.botId = botId;
        this.connectionId = connectionId;
        this.alias = alias;
        this.outboundPolicyRevision = outboundPolicyRevision;
        this.lifecycleRevision = lifecycleRevision;
        this.ownerApproved = ownerApproved;
        this.createdAt = createdAt;
    }
}

export class ActiveBotDeliveryTarget extends BotDeliveryTarget {
    readonly lifecycle = "active";

    constructor(
        deliveryTargetId: string,
        botId: string,
        connectionId: string,
        alias: string,
        outboundPolicyRevision: number,
        lifecycleRevision: number,
        ownerApproved: boolean,
        createdAt: string,
    ) {
        super(
            deliveryTargetId,
            botId,
            connectionId,
            alias,
            outboundPolicyRevision,
            lifecycleRevision,
            ownerApproved,
            createdAt,
        );
    }
}

export class DisabledBotDeliveryTarget extends BotDeliveryTarget {
    readonly disabledAt: string;
    readonly lifecycle = "disabled";

    constructor(target: BotDeliveryTarget, disabledAt: string) {
        super(
            target.deliveryTargetId,
            target.botId,
            target.connectionId,
            target.alias,
            target.outboundPolicyRevision,
            target.lifecycleRevision + 1,
            false,
            target.createdAt,
        );
        this.disabledAt = disabledAt;
    }
}

export abstract class BotCompletionDeliveryPolicy {
    abstract readonly kind: string;
}

export class NoBotCompletionDeliveryPolicy extends BotCompletionDeliveryPolicy {
    readonly kind = "none";
}

export class RequiredBotCompletionDeliveryPolicy extends BotCompletionDeliveryPolicy {
    readonly deliveryTargetId: string;
    readonly kind = "required";
    readonly messageTemplate: string;

    constructor(deliveryTargetId: string, messageTemplate: string) {
        super();
        this.deliveryTargetId = deliveryTargetId;
        this.messageTemplate = messageTemplate;
    }
}

export abstract class BotReplyRoute {
    abstract readonly kind: string;
}

export class OwnerBotReplyRoute extends BotReplyRoute {
    readonly kind = "owner";
}

export class BotConnectionReplyRoute extends BotReplyRoute {
    readonly connectionId: string;
    readonly deliveryTargetId: string;
    readonly kind = "connection";

    constructor(connectionId: string, deliveryTargetId: string) {
        super();
        this.connectionId = connectionId;
        this.deliveryTargetId = deliveryTargetId;
    }
}

export abstract class BotConversation {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly conversationId: string;
    readonly createdAt: string;
    readonly creatorPrincipalId: string;
    abstract readonly lifecycle: string;
    readonly sessionId: string;
    readonly title: string;

    protected constructor(
        conversationId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        sessionId: string,
        creatorPrincipalId: string,
        title: string,
        createdAt: string,
    ) {
        this.conversationId = conversationId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.sessionId = sessionId;
        this.creatorPrincipalId = creatorPrincipalId;
        this.title = title;
        this.createdAt = createdAt;
    }
}

export class ProvisioningBotConversation extends BotConversation {
    readonly lifecycle = "provisioning";

    constructor(
        conversationId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        sessionId: string,
        creatorPrincipalId: string,
        title: string,
        createdAt: string,
    ) {
        super(
            conversationId,
            botId,
            behaviorRevisionId,
            bindingId,
            bindingRevision,
            sessionId,
            creatorPrincipalId,
            title,
            createdAt,
        );
    }
}

export class ActiveBotConversation extends BotConversation {
    readonly activatedAt: string;
    readonly lifecycle = "active";

    constructor(conversation: BotConversation, activatedAt: string) {
        super(
            conversation.conversationId,
            conversation.botId,
            conversation.behaviorRevisionId,
            conversation.bindingId,
            conversation.bindingRevision,
            conversation.sessionId,
            conversation.creatorPrincipalId,
            conversation.title,
            conversation.createdAt,
        );
        this.activatedAt = activatedAt;
    }
}

export class OwnerBotConversation extends ActiveBotConversation {
    readonly creatorKind = "owner";
    readonly replyRoute = new OwnerBotReplyRoute();

    constructor(conversation: BotConversation, activatedAt: string) {
        super(conversation, activatedAt);
    }
}

export class ConnectedBotConversation extends ActiveBotConversation {
    readonly connectionId: string;
    readonly creatorKind = "connection";
    readonly replyRoute: BotConnectionReplyRoute;

    constructor(conversation: BotConversation, activatedAt: string, connectionId: string, deliveryTargetId: string) {
        super(conversation, activatedAt);
        this.connectionId = connectionId;
        this.replyRoute = new BotConnectionReplyRoute(connectionId, deliveryTargetId);
    }
}

export class ClosedBotConversation extends BotConversation {
    readonly closedAt: string;
    readonly lifecycle = "closed";

    constructor(conversation: BotConversation, closedAt: string) {
        super(
            conversation.conversationId,
            conversation.botId,
            conversation.behaviorRevisionId,
            conversation.bindingId,
            conversation.bindingRevision,
            conversation.sessionId,
            conversation.creatorPrincipalId,
            conversation.title,
            conversation.createdAt,
        );
        this.closedAt = closedAt;
    }
}

export class BotExecution {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly conversationId: string;
    readonly deadlineAt: string;
    readonly executionId: string;
    readonly runtimeId: string;
    readonly turnId: string;

    constructor(
        executionId: string,
        botId: string,
        conversationId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        runtimeId: string,
        deadlineAt: string,
    ) {
        this.executionId = executionId;
        this.botId = botId;
        this.conversationId = conversationId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.deadlineAt = deadlineAt;
    }
}

export class BotExecutionCapability {
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly operation: string;
    readonly turnId: string;
    readonly usageLimit: number;

    constructor(
        capabilityId: string,
        execution: BotExecution,
        allowedDeliveryTargetIds: readonly string[],
        operation: string,
        usageLimit: number,
        expiresAt: string,
    ) {
        this.capabilityId = capabilityId;
        this.executionId = execution.executionId;
        this.botId = execution.botId;
        this.conversationId = execution.conversationId;
        this.turnId = execution.turnId;
        this.behaviorRevisionId = execution.behaviorRevisionId;
        this.bindingId = execution.bindingId;
        this.bindingRevision = execution.bindingRevision;
        this.allowedDeliveryTargetIds = Object.freeze([...allowedDeliveryTargetIds]);
        this.operation = operation;
        this.usageLimit = usageLimit;
        this.expiresAt = expiresAt;
    }
}

export abstract class BotConnection {
    readonly audience: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly connectorPrincipalId: string;
    readonly createdAt: string;
    readonly label: string;
    abstract readonly lifecycle: string;
    readonly lifecycleRevision: number;
    readonly scopes: readonly string[];

    protected constructor(
        connectionId: string,
        botId: string,
        connectorPrincipalId: string,
        audience: string,
        label: string,
        scopes: readonly string[],
        lifecycleRevision: number,
        createdAt: string,
    ) {
        this.connectionId = connectionId;
        this.botId = botId;
        this.connectorPrincipalId = connectorPrincipalId;
        this.audience = audience;
        this.label = label;
        this.scopes = Object.freeze([...scopes]);
        this.lifecycleRevision = lifecycleRevision;
        this.createdAt = createdAt;
    }
}

export class ActiveBotConnection extends BotConnection {
    readonly lastUsedAt: string;
    readonly lifecycle = "active";

    constructor(
        connectionId: string,
        botId: string,
        connectorPrincipalId: string,
        audience: string,
        label: string,
        scopes: readonly string[],
        lifecycleRevision: number,
        createdAt: string,
        lastUsedAt: string,
    ) {
        super(connectionId, botId, connectorPrincipalId, audience, label, scopes, lifecycleRevision, createdAt);
        this.lastUsedAt = lastUsedAt;
    }
}

export class RevokedBotConnection extends BotConnection {
    readonly lifecycle = "revoked";
    readonly revokedAt: string;

    constructor(connection: BotConnection, revokedAt: string) {
        super(
            connection.connectionId,
            connection.botId,
            connection.connectorPrincipalId,
            connection.audience,
            connection.label,
            connection.scopes,
            connection.lifecycleRevision,
            connection.createdAt,
        );
        this.revokedAt = revokedAt;
    }
}

export class BotConnectionCredential {
    readonly connectionId: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly lastUsedAt: string;
    readonly secretDigest: string;

    constructor(
        credentialId: string,
        connectionId: string,
        secretDigest: string,
        issuedAt: string,
        expiresAt: string,
        lastUsedAt: string,
    ) {
        this.credentialId = credentialId;
        this.connectionId = connectionId;
        this.secretDigest = secretDigest;
        this.issuedAt = issuedAt;
        this.expiresAt = expiresAt;
        this.lastUsedAt = lastUsedAt;
    }
}

export class BotConnectionGrant {
    readonly audience: string;
    readonly botId: string;
    readonly expiresAt: string;
    readonly grantId: string;
    readonly scopes: readonly string[];
    readonly secretDigest: string;

    constructor(
        grantId: string,
        botId: string,
        audience: string,
        scopes: readonly string[],
        secretDigest: string,
        expiresAt: string,
    ) {
        this.grantId = grantId;
        this.botId = botId;
        this.audience = audience;
        this.scopes = Object.freeze([...scopes]);
        this.secretDigest = secretDigest;
        this.expiresAt = expiresAt;
    }
}

export abstract class OutboundMessageDelivery {
    readonly acceptedAt: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly conversationId: string;
    readonly deliveryTargetId: string;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly outboundMessageId: string;
    abstract readonly state: string;
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

export class AcceptedOutboundMessage extends OutboundMessageDelivery {
    readonly state = "accepted";
}

export abstract class SequencedOutboundMessage extends OutboundMessageDelivery {
    readonly sequence: number;

    constructor(message: OutboundMessageDelivery, sequence: number) {
        super(
            message.outboundMessageId,
            message.botId,
            message.conversationId,
            message.turnId,
            message.behaviorRevisionId,
            message.bindingId,
            message.bindingRevision,
            message.executionId,
            message.deliveryTargetId,
            message.idempotencyKey,
            message.text,
            message.acceptedAt,
            message.expiresAt,
        );
        this.sequence = sequence;
    }
}

export class QueuedOutboundMessage extends SequencedOutboundMessage {
    readonly state = "queued";
}

export class ClaimedOutboundMessage extends SequencedOutboundMessage {
    readonly claimDeadlineAt: string;
    readonly claimId: string;
    readonly state = "claimed";

    constructor(message: QueuedOutboundMessage, claimId: string, claimDeadlineAt: string) {
        super(message, message.sequence);
        this.claimId = claimId;
        this.claimDeadlineAt = claimDeadlineAt;
    }
}

export class DeliveredOutboundMessage extends SequencedOutboundMessage {
    readonly deliveredAt: string;
    readonly state = "delivered";

    constructor(message: QueuedOutboundMessage, deliveredAt: string) {
        super(message, message.sequence);
        this.deliveredAt = deliveredAt;
    }
}

export class RetryableFailedOutboundMessage extends SequencedOutboundMessage {
    readonly failedAt: string;
    readonly failureCode: string;
    readonly nextAttemptAt: string;
    readonly state = "retryable_failed";

    constructor(message: QueuedOutboundMessage, failureCode: string, failedAt: string, nextAttemptAt: string) {
        super(message, message.sequence);
        this.failureCode = failureCode;
        this.failedAt = failedAt;
        this.nextAttemptAt = nextAttemptAt;
    }
}

export class TerminalFailedOutboundMessage extends SequencedOutboundMessage {
    readonly failedAt: string;
    readonly failureCode: string;
    readonly state = "terminal_failed";

    constructor(message: QueuedOutboundMessage, failureCode: string, failedAt: string) {
        super(message, message.sequence);
        this.failureCode = failureCode;
        this.failedAt = failedAt;
    }
}

export class BotExecutionBindingApprovalRequest {
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
    readonly kind = BOT_BINDING_APPROVAL_REQUEST_KIND;
    readonly requestId: string;
    readonly requiredCapabilities: readonly string[];
    readonly runtimeId: string;
    readonly workspaceRef: string;

    constructor(
        requestId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        behaviorInstructions: string,
        behaviorDigest: string,
        requiredCapabilities: readonly string[],
        allowedDeliveryTargets: readonly BotDeliveryTargetReference[],
        completionPolicy: BotCompletionDeliveryPolicy,
    ) {
        this.requestId = requestId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.agentRef = agentRef;
        this.workspaceRef = workspaceRef;
        this.agentConfigRevision = agentConfigRevision;
        this.behaviorInstructions = behaviorInstructions;
        this.behaviorDigest = behaviorDigest;
        this.requiredCapabilities = Object.freeze([...requiredCapabilities]);
        this.allowedDeliveryTargets = Object.freeze(
            allowedDeliveryTargets.map(
                (target) => new BotDeliveryTargetReference(target.alias, target.deliveryTargetId),
            ),
        );
        this.completionPolicy = completionPolicy;
    }
}

export class BotExecutionBindingApprovedEvent {
    readonly agentIdentityDigest: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly kind = BOT_BINDING_APPROVED_KIND;
    readonly localGrantId: string;
    readonly requestId: string;
    readonly workspaceIdentityDigest: string;

    constructor(
        requestId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        localGrantId: string,
        agentIdentityDigest: string,
        workspaceIdentityDigest: string,
    ) {
        this.requestId = requestId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.localGrantId = localGrantId;
        this.agentIdentityDigest = agentIdentityDigest;
        this.workspaceIdentityDigest = workspaceIdentityDigest;
    }
}

export class BotExecutionBindingUnavailableEvent {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly code: string;
    readonly kind = BOT_BINDING_UNAVAILABLE_KIND;
    readonly message: string;
    readonly requestId: string;

    constructor(
        requestId: string,
        botId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        code: string,
        message: string,
    ) {
        this.requestId = requestId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.code = code;
        this.message = message;
    }
}

export class BotSessionPromptCommand {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly allowedDeliveryTargets: readonly BotDeliveryTargetReference[];
    readonly behaviorDigest: string;
    readonly behaviorInstructions: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly commandId: string;
    readonly conversationId: string;
    readonly directoryId: string;
    readonly executionCapabilityId: string;
    readonly executionCapabilitySecret: string;
    readonly executionDeadlineAt: string;
    readonly executionId: string;
    readonly images: readonly PromptImage[];
    readonly kind = BOT_SESSION_PROMPT_KIND;
    readonly localGrantId: string;
    readonly prompt: string;
    readonly replyRoute: BotReplyRoute;
    readonly resources: readonly PromptResource[];
    readonly sessionId: string;
    readonly turnId: string;

    constructor(
        sessionId: string,
        commandId: string,
        agentId: string,
        bindingId: string,
        directoryId: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        prompt: string,
        executionId: string,
        executionCapabilityId: string,
        executionCapabilitySecret: string,
        executionDeadlineAt: string,
        botId: string,
        conversationId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingRevision: number,
        localGrantId: string,
        behaviorInstructions: string,
        behaviorDigest: string,
        allowedDeliveryTargets: readonly BotDeliveryTargetReference[],
        replyRoute: BotReplyRoute,
    ) {
        this.sessionId = sessionId;
        this.commandId = commandId;
        this.agentId = agentId;
        this.bindingId = bindingId;
        this.directoryId = directoryId;
        this.additionalDirectoryIds = Object.freeze([...additionalDirectoryIds]);
        this.images = Object.freeze([...images]);
        this.resources = Object.freeze([...resources]);
        this.prompt = prompt;
        this.executionId = executionId;
        this.executionCapabilityId = executionCapabilityId;
        this.executionCapabilitySecret = executionCapabilitySecret;
        this.executionDeadlineAt = executionDeadlineAt;
        this.botId = botId;
        this.conversationId = conversationId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingRevision = bindingRevision;
        this.localGrantId = localGrantId;
        this.behaviorInstructions = behaviorInstructions;
        this.behaviorDigest = behaviorDigest;
        this.allowedDeliveryTargets = Object.freeze(
            allowedDeliveryTargets.map(
                (target) => new BotDeliveryTargetReference(target.alias, target.deliveryTargetId),
            ),
        );
        this.replyRoute = replyRoute;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(encoded: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ProtocolMessageError("Message is not valid JSON", { cause });
    }
    if (!isRecord(value)) {
        throw new ProtocolMessageError("Message must be a JSON object");
    }
    return value;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
        throw new ProtocolMessageError("Message fields do not match the Bot protocol");
    }
}

function readText(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty: boolean,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw new ProtocolMessageError(`Invalid Bot protocol field: ${key}`);
    }
    return field;
}

function readIdentifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readText(value, key, 128, false);
    if (!IDENTIFIER_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid Bot identifier field: ${key}`);
    }
    return field;
}

function readDirectoryIdentifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readText(value, key, 2_048, false);
    if (!DIRECTORY_IDENTIFIER_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid Bot directory field: ${key}`);
    }
    return field;
}

function readInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 1) {
        throw new ProtocolMessageError(`Invalid Bot integer field: ${key}`);
    }
    return field;
}

function readTimestamp(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readText(value, key, 64, false);
    if (Number.isNaN(Date.parse(field))) {
        throw new ProtocolMessageError(`Invalid Bot timestamp field: ${key}`);
    }
    return field;
}

function readDigest(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readText(value, key, 64, false);
    if (!SHA256_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid Bot digest field: ${key}`);
    }
    return field;
}

function readToken(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readText(value, key, 256, false);
    if (!TOKEN_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid Bot token field: ${key}`);
    }
    return field;
}

function readIdentifiers(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumCount: number,
): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumCount) {
        throw new ProtocolMessageError(`Invalid Bot identifier list: ${key}`);
    }
    const identifiers: string[] = [];
    const unique = new Set<string>();
    for (const candidate of field) {
        if (typeof candidate !== "string" || !IDENTIFIER_PATTERN.test(candidate) || unique.has(candidate)) {
            throw new ProtocolMessageError(`Invalid Bot identifier list: ${key}`);
        }
        unique.add(candidate);
        identifiers.push(candidate);
    }
    return Object.freeze(identifiers);
}

function readTargets(value: Readonly<Record<string, unknown>>, key: string): readonly BotDeliveryTargetReference[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > 64) {
        throw new ProtocolMessageError(`Invalid Bot delivery targets: ${key}`);
    }
    const targets: BotDeliveryTargetReference[] = [];
    const identifiers = new Set<string>();
    const aliases = new Set<string>();
    for (const candidate of field) {
        if (!isRecord(candidate)) {
            throw new ProtocolMessageError(`Invalid Bot delivery targets: ${key}`);
        }
        assertExactKeys(candidate, ["alias", "deliveryTargetId"]);
        const alias = readIdentifier(candidate, "alias");
        const deliveryTargetId = readIdentifier(candidate, "deliveryTargetId");
        if (aliases.has(alias) || identifiers.has(deliveryTargetId)) {
            throw new ProtocolMessageError(`Duplicate Bot delivery target: ${key}`);
        }
        aliases.add(alias);
        identifiers.add(deliveryTargetId);
        targets.push(new BotDeliveryTargetReference(alias, deliveryTargetId));
    }
    return Object.freeze(targets);
}

function readCompletionPolicy(value: unknown): BotCompletionDeliveryPolicy {
    if (!isRecord(value)) {
        throw new ProtocolMessageError("Invalid Bot completion policy");
    }
    const kind = readText(value, "kind", 32, false);
    if (kind === "none") {
        assertExactKeys(value, ["kind"]);
        return new NoBotCompletionDeliveryPolicy();
    }
    if (kind === "required") {
        assertExactKeys(value, ["deliveryTargetId", "kind", "messageTemplate"]);
        return new RequiredBotCompletionDeliveryPolicy(
            readIdentifier(value, "deliveryTargetId"),
            readText(value, "messageTemplate", 10_000, false),
        );
    }
    throw new ProtocolMessageError("Invalid Bot completion policy");
}

function readReplyRoute(value: unknown): BotReplyRoute {
    if (!isRecord(value)) {
        throw new ProtocolMessageError("Invalid Bot reply route");
    }
    const kind = readText(value, "kind", 32, false);
    if (kind === "owner") {
        assertExactKeys(value, ["kind"]);
        return new OwnerBotReplyRoute();
    }
    if (kind === "connection") {
        assertExactKeys(value, ["connectionId", "deliveryTargetId", "kind"]);
        return new BotConnectionReplyRoute(
            readIdentifier(value, "connectionId"),
            readIdentifier(value, "deliveryTargetId"),
        );
    }
    throw new ProtocolMessageError("Invalid Bot reply route");
}

export function decodeBotExecutionBindingApprovalRequest(encoded: string): BotExecutionBindingApprovalRequest {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "agentConfigRevision",
        "agentRef",
        "allowedDeliveryTargets",
        "behaviorDigest",
        "behaviorInstructions",
        "behaviorRevisionId",
        "bindingId",
        "bindingRevision",
        "botId",
        "completionPolicy",
        "kind",
        "requestId",
        "requiredCapabilities",
        "runtimeId",
        "workspaceRef",
    ]);
    if (value["kind"] !== BOT_BINDING_APPROVAL_REQUEST_KIND) {
        throw new ProtocolMessageError("Invalid Bot binding approval request kind");
    }
    return new BotExecutionBindingApprovalRequest(
        readIdentifier(value, "requestId"),
        readIdentifier(value, "botId"),
        readIdentifier(value, "behaviorRevisionId"),
        readIdentifier(value, "bindingId"),
        readInteger(value, "bindingRevision"),
        readIdentifier(value, "runtimeId"),
        readIdentifier(value, "agentRef"),
        readDirectoryIdentifier(value, "workspaceRef"),
        readInteger(value, "agentConfigRevision"),
        readText(value, "behaviorInstructions", MAX_INSTRUCTIONS_LENGTH, true),
        readDigest(value, "behaviorDigest"),
        readIdentifiers(value, "requiredCapabilities", 32),
        readTargets(value, "allowedDeliveryTargets"),
        readCompletionPolicy(value["completionPolicy"]),
    );
}

export function encodeBotExecutionBindingApprovalRequest(request: BotExecutionBindingApprovalRequest): string {
    return JSON.stringify(decodeBotExecutionBindingApprovalRequest(JSON.stringify(request)));
}

export function decodeBotExecutionBindingApprovedEvent(encoded: string): BotExecutionBindingApprovedEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "agentIdentityDigest",
        "behaviorRevisionId",
        "bindingId",
        "bindingRevision",
        "botId",
        "kind",
        "localGrantId",
        "requestId",
        "workspaceIdentityDigest",
    ]);
    if (value["kind"] !== BOT_BINDING_APPROVED_KIND) {
        throw new ProtocolMessageError("Invalid Bot binding approval event kind");
    }
    return new BotExecutionBindingApprovedEvent(
        readIdentifier(value, "requestId"),
        readIdentifier(value, "botId"),
        readIdentifier(value, "behaviorRevisionId"),
        readIdentifier(value, "bindingId"),
        readInteger(value, "bindingRevision"),
        readIdentifier(value, "localGrantId"),
        readDigest(value, "agentIdentityDigest"),
        readDigest(value, "workspaceIdentityDigest"),
    );
}

export function encodeBotExecutionBindingApprovedEvent(event: BotExecutionBindingApprovedEvent): string {
    return JSON.stringify(decodeBotExecutionBindingApprovedEvent(JSON.stringify(event)));
}

export function decodeBotExecutionBindingUnavailableEvent(encoded: string): BotExecutionBindingUnavailableEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "behaviorRevisionId",
        "bindingId",
        "bindingRevision",
        "botId",
        "code",
        "kind",
        "message",
        "requestId",
    ]);
    if (value["kind"] !== BOT_BINDING_UNAVAILABLE_KIND) {
        throw new ProtocolMessageError("Invalid Bot binding unavailable event kind");
    }
    return new BotExecutionBindingUnavailableEvent(
        readIdentifier(value, "requestId"),
        readIdentifier(value, "botId"),
        readIdentifier(value, "behaviorRevisionId"),
        readIdentifier(value, "bindingId"),
        readInteger(value, "bindingRevision"),
        readIdentifier(value, "code"),
        readText(value, "message", 500, false),
    );
}

export function encodeBotExecutionBindingUnavailableEvent(event: BotExecutionBindingUnavailableEvent): string {
    return JSON.stringify(decodeBotExecutionBindingUnavailableEvent(JSON.stringify(event)));
}

export function decodeBotSessionPromptCommand(encoded: string): BotSessionPromptCommand {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "additionalDirectoryIds",
        "agentId",
        "allowedDeliveryTargets",
        "behaviorDigest",
        "behaviorInstructions",
        "behaviorRevisionId",
        "bindingId",
        "bindingRevision",
        "botId",
        "commandId",
        "conversationId",
        "directoryId",
        "executionCapabilityId",
        "executionCapabilitySecret",
        "executionDeadlineAt",
        "executionId",
        "images",
        "kind",
        "localGrantId",
        "prompt",
        "replyRoute",
        "resources",
        "sessionId",
        "turnId",
    ]);
    if (value["kind"] !== BOT_SESSION_PROMPT_KIND) {
        throw new ProtocolMessageError("Invalid Bot Session prompt kind");
    }
    return new BotSessionPromptCommand(
        readIdentifier(value, "sessionId"),
        readIdentifier(value, "commandId"),
        readIdentifier(value, "agentId"),
        readIdentifier(value, "bindingId"),
        readDirectoryIdentifier(value, "directoryId"),
        readIdentifiers(value, "additionalDirectoryIds", 16),
        decodePromptImagesValue(value["images"]),
        decodePromptResourcesValue(value["resources"]),
        readText(value, "prompt", 10_000, false),
        readIdentifier(value, "executionId"),
        readIdentifier(value, "executionCapabilityId"),
        readToken(value, "executionCapabilitySecret"),
        readTimestamp(value, "executionDeadlineAt"),
        readIdentifier(value, "botId"),
        readIdentifier(value, "conversationId"),
        readIdentifier(value, "turnId"),
        readIdentifier(value, "behaviorRevisionId"),
        readInteger(value, "bindingRevision"),
        readIdentifier(value, "localGrantId"),
        readText(value, "behaviorInstructions", MAX_INSTRUCTIONS_LENGTH, true),
        readDigest(value, "behaviorDigest"),
        readTargets(value, "allowedDeliveryTargets"),
        readReplyRoute(value["replyRoute"]),
    );
}

export function encodeBotSessionPromptCommand(command: BotSessionPromptCommand): string {
    return JSON.stringify(decodeBotSessionPromptCommand(JSON.stringify(command)));
}
