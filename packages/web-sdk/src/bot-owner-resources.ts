import { MobiusProtocolError } from "./errors.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function invalid(name: string): MobiusProtocolError {
    return new MobiusProtocolError(`The service returned an invalid ${name}`);
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalid(name);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], name: string): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw invalid(name);
    }
}

function text(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw invalid(name);
    }
    return field;
}

function identifier(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = text(value, key, name);
    if (!IDENTIFIER_PATTERN.test(field)) {
        throw invalid(name);
    }
    return field;
}

function integer(value: Readonly<Record<string, unknown>>, key: string, name: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw invalid(name);
    }
    return field;
}

function boolean(value: Readonly<Record<string, unknown>>, key: string, name: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw invalid(name);
    }
    return field;
}

function timestamp(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = text(value, key, name);
    if (Number.isNaN(Date.parse(field))) {
        throw invalid(name);
    }
    return field;
}

function texts(value: Readonly<Record<string, unknown>>, key: string, name: string): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.some((candidate) => typeof candidate !== "string")) {
        throw invalid(name);
    }
    return Object.freeze(field.filter((candidate) => typeof candidate === "string"));
}

function records(value: Readonly<Record<string, unknown>>, key: string, name: string): readonly unknown[] {
    const field = value[key];
    if (!Array.isArray(field)) {
        throw invalid(name);
    }
    return Object.freeze([...field]);
}

export abstract class MobiusBotState {
    abstract readonly kind: string;
}

export class MobiusDraftBotState extends MobiusBotState {
    readonly kind = "draft";
}

export class MobiusActiveBotState extends MobiusBotState {
    readonly activeBehaviorRevisionId: string;
    readonly activeBindingId: string;
    readonly kind = "active";

    constructor(activeBehaviorRevisionId: string, activeBindingId: string) {
        super();
        this.activeBehaviorRevisionId = activeBehaviorRevisionId;
        this.activeBindingId = activeBindingId;
    }
}

export class MobiusSuspendedBotState extends MobiusBotState {
    readonly activeBehaviorRevisionId: string;
    readonly activeBindingId: string;
    readonly kind = "suspended";
    readonly suspendedAt: string;

    constructor(activeBehaviorRevisionId: string, activeBindingId: string, suspendedAt: string) {
        super();
        this.activeBehaviorRevisionId = activeBehaviorRevisionId;
        this.activeBindingId = activeBindingId;
        this.suspendedAt = suspendedAt;
    }
}

export class MobiusArchivedBotState extends MobiusBotState {
    readonly archivedAt: string;
    readonly kind = "archived";

    constructor(archivedAt: string) {
        super();
        this.archivedAt = archivedAt;
    }
}

export class MobiusBot {
    readonly avatarRef: string;
    readonly botId: string;
    readonly createdAt: string;
    readonly currentProfileRevisionId: string;
    readonly description: string;
    readonly displayName: string;
    readonly lifecycleRevision: number;
    readonly profileRevision: number;
    readonly projectId: string;
    readonly state: MobiusBotState;
    readonly updatedAt: string;

    constructor(resource: Readonly<Record<string, unknown>>, state: MobiusBotState, name = "Bot") {
        this.avatarRef = text(resource, "avatarRef", name, true);
        this.botId = identifier(resource, "botId", name);
        this.createdAt = timestamp(resource, "createdAt", name);
        this.currentProfileRevisionId = identifier(resource, "currentProfileRevisionId", name);
        this.description = text(resource, "description", name, true);
        this.displayName = text(resource, "displayName", name);
        this.lifecycleRevision = integer(resource, "lifecycleRevision", name);
        this.profileRevision = integer(resource, "profileRevision", name);
        this.projectId = identifier(resource, "projectId", name);
        this.state = state;
        this.updatedAt = timestamp(resource, "updatedAt", name);
    }
}

const BOT_FIELDS = [
    "avatarRef",
    "botId",
    "createdAt",
    "currentProfileRevisionId",
    "description",
    "displayName",
    "lifecycle",
    "lifecycleRevision",
    "profileRevision",
    "projectId",
    "updatedAt",
];

export function decodeMobiusBot(value: unknown): MobiusBot {
    const name = "Bot";
    const resource = record(value, name);
    const lifecycle = resource["lifecycle"];
    if (lifecycle === "draft") {
        exact(resource, BOT_FIELDS, name);
        return new MobiusBot(resource, new MobiusDraftBotState());
    }
    if (lifecycle === "active") {
        exact(resource, [...BOT_FIELDS, "activeBehaviorRevisionId", "activeBindingId"], name);
        return new MobiusBot(
            resource,
            new MobiusActiveBotState(
                identifier(resource, "activeBehaviorRevisionId", name),
                identifier(resource, "activeBindingId", name),
            ),
        );
    }
    if (lifecycle === "suspended") {
        exact(resource, [...BOT_FIELDS, "activeBehaviorRevisionId", "activeBindingId", "suspendedAt"], name);
        return new MobiusBot(
            resource,
            new MobiusSuspendedBotState(
                identifier(resource, "activeBehaviorRevisionId", name),
                identifier(resource, "activeBindingId", name),
                timestamp(resource, "suspendedAt", name),
            ),
        );
    }
    if (lifecycle === "archived") {
        exact(resource, [...BOT_FIELDS, "archivedAt"], name);
        return new MobiusBot(resource, new MobiusArchivedBotState(timestamp(resource, "archivedAt", name)));
    }
    throw invalid(name);
}

export class MobiusBotDirectory {
    readonly bots: readonly MobiusBot[];

    constructor(value: unknown) {
        const resource = record(value, "Bot directory");
        exact(resource, ["bots"], "Bot directory");
        this.bots = Object.freeze(records(resource, "bots", "Bot directory").map(decodeMobiusBot));
    }
}

export abstract class MobiusBotBehaviorState {
    abstract readonly kind: string;
}

export class MobiusProposedBotBehaviorState extends MobiusBotBehaviorState {
    readonly kind = "proposed";
}

export class MobiusAwaitingBotBehaviorState extends MobiusBotBehaviorState {
    readonly kind = "awaiting_local_approval";
}

export class MobiusApprovedBotBehaviorState extends MobiusBotBehaviorState {
    readonly approvedAt: string;
    readonly kind = "approved";

    constructor(approvedAt: string) {
        super();
        this.approvedAt = approvedAt;
    }
}

export class MobiusRetiredBotBehaviorState extends MobiusBotBehaviorState {
    readonly kind = "retired";
    readonly retiredAt: string;

    constructor(retiredAt: string) {
        super();
        this.retiredAt = retiredAt;
    }
}

export class MobiusBotBehaviorRevision {
    readonly agentConfiguration: Readonly<Record<string, unknown>>;
    readonly behaviorRevisionId: string;
    readonly botId: string;
    readonly contentDigest: string;
    readonly createdAt: string;
    readonly instructions: string;
    readonly requiredCapabilities: readonly string[];
    readonly revisionNumber: number;
    readonly state: MobiusBotBehaviorState;

    constructor(resource: Readonly<Record<string, unknown>>, state: MobiusBotBehaviorState) {
        this.agentConfiguration = record(resource["agentConfiguration"], "Bot behavior configuration");
        this.behaviorRevisionId = identifier(resource, "behaviorRevisionId", "Bot behavior");
        this.botId = identifier(resource, "botId", "Bot behavior");
        this.contentDigest = text(resource, "contentDigest", "Bot behavior");
        this.createdAt = timestamp(resource, "createdAt", "Bot behavior");
        this.instructions = text(resource, "instructions", "Bot behavior", true);
        this.requiredCapabilities = texts(resource, "requiredCapabilities", "Bot behavior");
        this.revisionNumber = integer(resource, "revisionNumber", "Bot behavior");
        this.state = state;
    }
}

const BEHAVIOR_FIELDS = [
    "agentConfiguration",
    "behaviorRevisionId",
    "botId",
    "contentDigest",
    "createdAt",
    "instructions",
    "lifecycle",
    "requiredCapabilities",
    "revisionNumber",
];

export function decodeMobiusBotBehavior(value: unknown): MobiusBotBehaviorRevision {
    const name = "Bot behavior";
    const resource = record(value, name);
    const lifecycle = resource["lifecycle"];
    if (lifecycle === "proposed") {
        exact(resource, BEHAVIOR_FIELDS, name);
        return new MobiusBotBehaviorRevision(resource, new MobiusProposedBotBehaviorState());
    }
    if (lifecycle === "awaiting_local_approval") {
        exact(resource, BEHAVIOR_FIELDS, name);
        return new MobiusBotBehaviorRevision(resource, new MobiusAwaitingBotBehaviorState());
    }
    if (lifecycle === "approved") {
        exact(resource, [...BEHAVIOR_FIELDS, "approvedAt"], name);
        return new MobiusBotBehaviorRevision(
            resource,
            new MobiusApprovedBotBehaviorState(timestamp(resource, "approvedAt", name)),
        );
    }
    if (lifecycle === "retired") {
        exact(resource, [...BEHAVIOR_FIELDS, "retiredAt"], name);
        return new MobiusBotBehaviorRevision(
            resource,
            new MobiusRetiredBotBehaviorState(timestamp(resource, "retiredAt", name)),
        );
    }
    throw invalid(name);
}

export class MobiusBotBehaviorDirectory {
    readonly behaviorRevisions: readonly MobiusBotBehaviorRevision[];

    constructor(value: unknown) {
        const resource = record(value, "Bot behavior directory");
        exact(resource, ["behaviorRevisions"], "Bot behavior directory");
        this.behaviorRevisions = Object.freeze(
            records(resource, "behaviorRevisions", "Bot behavior directory").map(decodeMobiusBotBehavior),
        );
    }
}

export abstract class MobiusBotCompletionPolicy {
    abstract readonly kind: string;
}

export class MobiusNoBotCompletionPolicy extends MobiusBotCompletionPolicy {
    readonly kind = "none";
}

export class MobiusRequiredBotCompletionPolicy extends MobiusBotCompletionPolicy {
    readonly deliveryTargetId: string;
    readonly kind = "required";
    readonly messageTemplate: string;

    constructor(deliveryTargetId: string, messageTemplate: string) {
        super();
        this.deliveryTargetId = deliveryTargetId;
        this.messageTemplate = messageTemplate;
    }
}

function decodeCompletionPolicy(value: unknown): MobiusBotCompletionPolicy {
    const resource = record(value, "Bot completion policy");
    if (resource["kind"] === "none") {
        exact(resource, ["kind"], "Bot completion policy");
        return new MobiusNoBotCompletionPolicy();
    }
    if (resource["kind"] === "required") {
        exact(resource, ["deliveryTargetId", "kind", "messageTemplate"], "Bot completion policy");
        return new MobiusRequiredBotCompletionPolicy(
            identifier(resource, "deliveryTargetId", "Bot completion policy"),
            text(resource, "messageTemplate", "Bot completion policy"),
        );
    }
    throw invalid("Bot completion policy");
}

export abstract class MobiusBotBindingState {
    abstract readonly kind: string;
}

export class MobiusRequestedBotBindingState extends MobiusBotBindingState {
    readonly kind = "requested";
}

export class MobiusApprovedBotBindingState extends MobiusBotBindingState {
    readonly approvedAt: string;
    readonly kind = "approved";

    constructor(approvedAt: string) {
        super();
        this.approvedAt = approvedAt;
    }
}

export class MobiusUnavailableBotBindingState extends MobiusBotBindingState {
    readonly code: string;
    readonly kind = "unavailable";
    readonly message: string;
    readonly unavailableAt: string;

    constructor(code: string, message: string, unavailableAt: string) {
        super();
        this.code = code;
        this.message = message;
        this.unavailableAt = unavailableAt;
    }
}

export class MobiusRevokedBotBindingState extends MobiusBotBindingState {
    readonly kind = "revoked";
    readonly revokedAt: string;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export class MobiusBotExecutionBinding {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: MobiusBotCompletionPolicy;
    readonly createdAt: string;
    readonly runtimeId: string;
    readonly state: MobiusBotBindingState;
    readonly workspaceRef: string;

    constructor(resource: Readonly<Record<string, unknown>>, state: MobiusBotBindingState) {
        this.agentConfigRevision = integer(resource, "agentConfigRevision", "Bot execution binding");
        this.agentRef = identifier(resource, "agentRef", "Bot execution binding");
        this.allowedDeliveryTargetIds = texts(resource, "allowedDeliveryTargetIds", "Bot execution binding");
        this.behaviorRevisionId = identifier(resource, "behaviorRevisionId", "Bot execution binding");
        this.bindingId = identifier(resource, "bindingId", "Bot execution binding");
        this.bindingRevision = integer(resource, "bindingRevision", "Bot execution binding");
        this.botId = identifier(resource, "botId", "Bot execution binding");
        this.completionPolicy = decodeCompletionPolicy(resource["completionPolicy"]);
        this.createdAt = timestamp(resource, "createdAt", "Bot execution binding");
        this.runtimeId = identifier(resource, "runtimeId", "Bot execution binding");
        this.state = state;
        this.workspaceRef = text(resource, "workspaceRef", "Bot execution binding");
    }
}

const BINDING_FIELDS = [
    "agentConfigRevision",
    "agentRef",
    "allowedDeliveryTargetIds",
    "behaviorRevisionId",
    "bindingId",
    "bindingRevision",
    "botId",
    "completionPolicy",
    "createdAt",
    "lifecycle",
    "runtimeId",
    "workspaceRef",
];

function decodeMobiusBotExecutionBinding(value: unknown): MobiusBotExecutionBinding {
    const name = "Bot execution binding";
    const resource = record(value, name);
    const lifecycle = resource["lifecycle"];
    if (lifecycle === "requested") {
        exact(resource, BINDING_FIELDS, name);
        return new MobiusBotExecutionBinding(resource, new MobiusRequestedBotBindingState());
    }
    if (lifecycle === "approved") {
        exact(resource, [...BINDING_FIELDS, "approvedAt"], name);
        return new MobiusBotExecutionBinding(
            resource,
            new MobiusApprovedBotBindingState(timestamp(resource, "approvedAt", name)),
        );
    }
    if (lifecycle === "unavailable") {
        exact(resource, [...BINDING_FIELDS, "code", "message", "unavailableAt"], name);
        return new MobiusBotExecutionBinding(
            resource,
            new MobiusUnavailableBotBindingState(
                identifier(resource, "code", name),
                text(resource, "message", name),
                timestamp(resource, "unavailableAt", name),
            ),
        );
    }
    if (lifecycle === "revoked") {
        exact(resource, [...BINDING_FIELDS, "revokedAt"], name);
        return new MobiusBotExecutionBinding(
            resource,
            new MobiusRevokedBotBindingState(timestamp(resource, "revokedAt", name)),
        );
    }
    throw invalid(name);
}

export class MobiusBotBindingDirectory {
    readonly executionBindings: readonly MobiusBotExecutionBinding[];

    constructor(value: unknown) {
        const resource = record(value, "Bot binding directory");
        exact(resource, ["executionBindings"], "Bot binding directory");
        this.executionBindings = Object.freeze(
            records(resource, "executionBindings", "Bot binding directory").map(decodeMobiusBotExecutionBinding),
        );
    }
}

export class MobiusBotProfileRevision {
    readonly avatarRef: string;
    readonly botId: string;
    readonly createdAt: string;
    readonly description: string;
    readonly displayName: string;
    readonly lifecycleRevision: number;
    readonly profileRevisionId: string;
    readonly revisionNumber: number;

    constructor(value: unknown) {
        const name = "Bot profile revision";
        const resource = record(value, name);
        exact(
            resource,
            [
                "avatarRef",
                "botId",
                "createdAt",
                "description",
                "displayName",
                "lifecycleRevision",
                "profileRevisionId",
                "revisionNumber",
            ],
            name,
        );
        this.avatarRef = text(resource, "avatarRef", name, true);
        this.botId = identifier(resource, "botId", name);
        this.createdAt = timestamp(resource, "createdAt", name);
        this.description = text(resource, "description", name, true);
        this.displayName = text(resource, "displayName", name);
        this.lifecycleRevision = integer(resource, "lifecycleRevision", name);
        this.profileRevisionId = identifier(resource, "profileRevisionId", name);
        this.revisionNumber = integer(resource, "revisionNumber", name);
    }
}

export class MobiusBotBindingRequestAcceptance {
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly lifecycle = "requested";

    constructor(value: unknown) {
        const name = "Bot binding request acceptance";
        const resource = record(value, name);
        exact(resource, ["bindingId", "bindingRevision", "lifecycle"], name);
        if (resource["lifecycle"] !== "requested") {
            throw invalid(name);
        }
        this.bindingId = identifier(resource, "bindingId", name);
        this.bindingRevision = integer(resource, "bindingRevision", name);
    }
}

export abstract class MobiusBotConversationState {
    abstract readonly kind: string;
}

export class MobiusProvisioningBotConversationState extends MobiusBotConversationState {
    readonly kind = "provisioning";
}

export class MobiusActiveBotConversationState extends MobiusBotConversationState {
    readonly kind = "active";
}

export class MobiusClosedBotConversationState extends MobiusBotConversationState {
    readonly kind = "closed";
}

export abstract class MobiusBotConversationOrigin {
    abstract readonly kind: string;
}

export class MobiusOwnerBotConversationOrigin extends MobiusBotConversationOrigin {
    readonly kind = "owner";
}

export class MobiusConnectedBotConversationOrigin extends MobiusBotConversationOrigin {
    readonly connectionId: string;
    readonly kind = "connection";
    readonly replyDeliveryTargetId: string;

    constructor(connectionId: string, replyDeliveryTargetId: string) {
        super();
        this.connectionId = connectionId;
        this.replyDeliveryTargetId = replyDeliveryTargetId;
    }
}

export class MobiusBotConversation {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly clientConversationKey: string;
    readonly conversationId: string;
    readonly createdAt: string;
    readonly creatorPrincipalId: string;
    readonly origin: MobiusBotConversationOrigin;
    readonly sessionId: string;
    readonly state: MobiusBotConversationState;
    readonly title: string;

    constructor(
        resource: Readonly<Record<string, unknown>>,
        origin: MobiusBotConversationOrigin,
        state: MobiusBotConversationState,
    ) {
        const name = "Bot conversation";
        this.behaviorRevisionId = identifier(resource, "behaviorRevisionId", name);
        this.bindingId = identifier(resource, "bindingId", name);
        this.bindingRevision = integer(resource, "bindingRevision", name);
        this.botId = identifier(resource, "botId", name);
        this.clientConversationKey = identifier(resource, "clientConversationKey", name);
        this.conversationId = identifier(resource, "conversationId", name);
        this.createdAt = timestamp(resource, "createdAt", name);
        this.creatorPrincipalId = text(resource, "creatorPrincipalId", name);
        this.origin = origin;
        this.sessionId = identifier(resource, "sessionId", name);
        this.state = state;
        this.title = text(resource, "title", name, true);
    }
}

const CONVERSATION_FIELDS = [
    "behaviorRevisionId",
    "bindingId",
    "bindingRevision",
    "botId",
    "clientConversationKey",
    "conversationId",
    "createdAt",
    "creatorKind",
    "creatorPrincipalId",
    "lifecycle",
    "sessionId",
    "title",
];

function conversationState(resource: Readonly<Record<string, unknown>>): MobiusBotConversationState {
    if (resource["lifecycle"] === "provisioning") {
        return new MobiusProvisioningBotConversationState();
    }
    if (resource["lifecycle"] === "active") {
        return new MobiusActiveBotConversationState();
    }
    if (resource["lifecycle"] === "closed") {
        return new MobiusClosedBotConversationState();
    }
    throw invalid("Bot conversation");
}

export function decodeMobiusOwnerBotConversation(value: unknown): MobiusBotConversation {
    const resource = record(value, "owner Bot conversation");
    exact(resource, CONVERSATION_FIELDS, "owner Bot conversation");
    if (resource["creatorKind"] !== "owner") {
        throw invalid("owner Bot conversation");
    }
    return new MobiusBotConversation(resource, new MobiusOwnerBotConversationOrigin(), conversationState(resource));
}

function decodeMobiusBotConversation(value: unknown): MobiusBotConversation {
    const resource = record(value, "Bot conversation");
    if (resource["creatorKind"] === "owner") {
        return decodeMobiusOwnerBotConversation(resource);
    }
    if (resource["creatorKind"] === "connection") {
        exact(resource, [...CONVERSATION_FIELDS, "connectionId", "replyDeliveryTargetId"], "Bot conversation");
        return new MobiusBotConversation(
            resource,
            new MobiusConnectedBotConversationOrigin(
                identifier(resource, "connectionId", "Bot conversation"),
                identifier(resource, "replyDeliveryTargetId", "Bot conversation"),
            ),
            conversationState(resource),
        );
    }
    throw invalid("Bot conversation");
}

export class MobiusBotConversationDirectory {
    readonly conversations: readonly MobiusBotConversation[];

    constructor(value: unknown) {
        const resource = record(value, "Bot conversation directory");
        exact(resource, ["conversations"], "Bot conversation directory");
        this.conversations = Object.freeze(
            records(resource, "conversations", "Bot conversation directory").map(decodeMobiusBotConversation),
        );
    }
}

export abstract class MobiusBotConnectionState {
    abstract readonly kind: string;
}

export class MobiusActiveBotConnectionState extends MobiusBotConnectionState {
    readonly kind = "active";
    readonly lastUsedAt: string;

    constructor(lastUsedAt: string) {
        super();
        this.lastUsedAt = lastUsedAt;
    }
}

export class MobiusRevokedBotConnectionState extends MobiusBotConnectionState {
    readonly kind = "revoked";
    readonly revokedAt: string;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export class MobiusOwnerBotConnection {
    readonly audience: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly connectorPrincipalId: string;
    readonly createdAt: string;
    readonly label: string;
    readonly lifecycleRevision: number;
    readonly scopes: readonly string[];
    readonly state: MobiusBotConnectionState;

    constructor(resource: Readonly<Record<string, unknown>>, state: MobiusBotConnectionState) {
        const name = "Bot connection";
        this.audience = identifier(resource, "audience", name);
        this.botId = identifier(resource, "botId", name);
        this.connectionId = identifier(resource, "connectionId", name);
        this.connectorPrincipalId = text(resource, "connectorPrincipalId", name);
        this.createdAt = timestamp(resource, "createdAt", name);
        this.label = text(resource, "label", name);
        this.lifecycleRevision = integer(resource, "lifecycleRevision", name);
        this.scopes = texts(resource, "scopes", name);
        this.state = state;
    }
}

const CONNECTION_FIELDS = [
    "audience",
    "botId",
    "connectionId",
    "connectorPrincipalId",
    "createdAt",
    "label",
    "lifecycle",
    "lifecycleRevision",
    "scopes",
];

function decodeMobiusOwnerBotConnection(value: unknown): MobiusOwnerBotConnection {
    const name = "Bot connection";
    const resource = record(value, name);
    if (resource["lifecycle"] === "active") {
        exact(resource, [...CONNECTION_FIELDS, "lastUsedAt"], name);
        return new MobiusOwnerBotConnection(
            resource,
            new MobiusActiveBotConnectionState(timestamp(resource, "lastUsedAt", name)),
        );
    }
    if (resource["lifecycle"] === "revoked") {
        exact(resource, [...CONNECTION_FIELDS, "revokedAt"], name);
        return new MobiusOwnerBotConnection(
            resource,
            new MobiusRevokedBotConnectionState(timestamp(resource, "revokedAt", name)),
        );
    }
    throw invalid(name);
}

export abstract class MobiusBotDeliveryTargetState {
    abstract readonly kind: string;
}

export class MobiusActiveBotDeliveryTargetState extends MobiusBotDeliveryTargetState {
    readonly kind = "active";
}

export class MobiusDisabledBotDeliveryTargetState extends MobiusBotDeliveryTargetState {
    readonly disabledAt: string;
    readonly kind = "disabled";

    constructor(disabledAt: string) {
        super();
        this.disabledAt = disabledAt;
    }
}

export class MobiusOwnerBotDeliveryTarget {
    readonly alias: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly createdAt: string;
    readonly deliveryTargetId: string;
    readonly lifecycleRevision: number;
    readonly outboundPolicyRevision: number;
    readonly ownerApproved: boolean;
    readonly state: MobiusBotDeliveryTargetState;
    readonly updatedAt: string;

    constructor(resource: Readonly<Record<string, unknown>>, state: MobiusBotDeliveryTargetState) {
        const name = "Bot delivery target";
        this.alias = text(resource, "alias", name);
        this.botId = identifier(resource, "botId", name);
        this.connectionId = identifier(resource, "connectionId", name);
        this.createdAt = timestamp(resource, "createdAt", name);
        this.deliveryTargetId = identifier(resource, "deliveryTargetId", name);
        this.lifecycleRevision = integer(resource, "lifecycleRevision", name);
        this.outboundPolicyRevision = integer(resource, "outboundPolicyRevision", name);
        this.ownerApproved = boolean(resource, "ownerApproved", name);
        this.state = state;
        this.updatedAt = timestamp(resource, "updatedAt", name);
    }
}

const TARGET_FIELDS = [
    "alias",
    "botId",
    "connectionId",
    "createdAt",
    "deliveryTargetId",
    "lifecycle",
    "lifecycleRevision",
    "outboundPolicyRevision",
    "ownerApproved",
    "updatedAt",
];

function decodeMobiusOwnerBotDeliveryTarget(value: unknown): MobiusOwnerBotDeliveryTarget {
    const name = "Bot delivery target";
    const resource = record(value, name);
    if (resource["lifecycle"] === "active") {
        exact(resource, TARGET_FIELDS, name);
        return new MobiusOwnerBotDeliveryTarget(resource, new MobiusActiveBotDeliveryTargetState());
    }
    if (resource["lifecycle"] === "disabled") {
        exact(resource, [...TARGET_FIELDS, "disabledAt"], name);
        return new MobiusOwnerBotDeliveryTarget(
            resource,
            new MobiusDisabledBotDeliveryTargetState(timestamp(resource, "disabledAt", name)),
        );
    }
    throw invalid(name);
}

export class MobiusBotConnectionDirectory {
    readonly connections: readonly MobiusOwnerBotConnection[];
    readonly deliveryTargets: readonly MobiusOwnerBotDeliveryTarget[];

    constructor(value: unknown) {
        const resource = record(value, "Bot connection directory");
        exact(resource, ["connections", "deliveryTargets"], "Bot connection directory");
        this.connections = Object.freeze(
            records(resource, "connections", "Bot connection directory").map(decodeMobiusOwnerBotConnection),
        );
        this.deliveryTargets = Object.freeze(
            records(resource, "deliveryTargets", "Bot connection directory").map(decodeMobiusOwnerBotDeliveryTarget),
        );
    }
}

export class MobiusBotConnectionGrant {
    readonly audience: string;
    readonly botId: string;
    readonly expiresAt: string;
    readonly grantId: string;
    readonly grantSecret: string;
    readonly label: string;
    readonly scopes: readonly string[];

    constructor(value: unknown) {
        const name = "Bot connection grant";
        const resource = record(value, name);
        exact(resource, ["audience", "botId", "expiresAt", "grantId", "grantSecret", "label", "scopes"], name);
        this.audience = identifier(resource, "audience", name);
        this.botId = identifier(resource, "botId", name);
        this.expiresAt = timestamp(resource, "expiresAt", name);
        this.grantId = identifier(resource, "grantId", name);
        this.grantSecret = text(resource, "grantSecret", name);
        this.label = text(resource, "label", name);
        this.scopes = texts(resource, "scopes", name);
    }
}
