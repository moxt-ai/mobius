import { MobiusProtocolError } from "./errors.ts";

function invalid(name: string): MobiusProtocolError {
    return new MobiusProtocolError(`The service returned an invalid ${name}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw invalid(name);
    }
    return value;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], name: string): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw invalid(name);
    }
}

function text(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = value[key];
    if (typeof field !== "string") {
        throw invalid(name);
    }
    return field;
}

function nonemptyText(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = text(value, key, name);
    if (field.length === 0) {
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
    const field = nonemptyText(value, key, name);
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

export class MobiusBotConnectionCredential {
    readonly audience: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly connectorPrincipalId: string;
    readonly credential: string;
    readonly credentialExpiresAt: string;
    readonly credentialId: string;
    readonly label: string;
    readonly lifecycle = "active";
    readonly lifecycleRevision: number;
    readonly scopes: readonly string[];

    constructor(value: unknown) {
        const resource = record(value, "Bot connection credential");
        exact(
            resource,
            [
                "audience",
                "botId",
                "connectionId",
                "connectorPrincipalId",
                "credential",
                "credentialExpiresAt",
                "credentialId",
                "label",
                "lifecycle",
                "lifecycleRevision",
                "scopes",
            ],
            "Bot connection credential",
        );
        if (resource["lifecycle"] !== "active") {
            throw invalid("Bot connection credential");
        }
        this.audience = nonemptyText(resource, "audience", "Bot connection credential");
        this.botId = nonemptyText(resource, "botId", "Bot connection credential");
        this.connectionId = nonemptyText(resource, "connectionId", "Bot connection credential");
        this.connectorPrincipalId = nonemptyText(resource, "connectorPrincipalId", "Bot connection credential");
        this.credential = nonemptyText(resource, "credential", "Bot connection credential");
        this.credentialExpiresAt = timestamp(resource, "credentialExpiresAt", "Bot connection credential");
        this.credentialId = nonemptyText(resource, "credentialId", "Bot connection credential");
        this.label = nonemptyText(resource, "label", "Bot connection credential");
        this.lifecycleRevision = integer(resource, "lifecycleRevision", "Bot connection credential");
        this.scopes = texts(resource, "scopes", "Bot connection credential");
    }
}

export class MobiusBotConnectionCredentialRotation {
    readonly connectionId: string;
    readonly credential: string;
    readonly credentialExpiresAt: string;
    readonly credentialId: string;
    readonly overlapEndsAt: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot credential rotation");
        exact(
            resource,
            ["connectionId", "credential", "credentialExpiresAt", "credentialId", "overlapEndsAt"],
            "Bot credential rotation",
        );
        this.connectionId = nonemptyText(resource, "connectionId", "Bot credential rotation");
        this.credential = nonemptyText(resource, "credential", "Bot credential rotation");
        this.credentialExpiresAt = timestamp(resource, "credentialExpiresAt", "Bot credential rotation");
        this.credentialId = nonemptyText(resource, "credentialId", "Bot credential rotation");
        this.overlapEndsAt = timestamp(resource, "overlapEndsAt", "Bot credential rotation");
    }
}

export class MobiusRevokedBotConnection {
    readonly botId: string;
    readonly connectionId: string;
    readonly lifecycle = "revoked";
    readonly lifecycleRevision: number;
    readonly revokedAt: string;

    constructor(value: unknown) {
        const resource = record(value, "revoked Bot connection");
        exact(
            resource,
            ["botId", "connectionId", "lifecycle", "lifecycleRevision", "revokedAt"],
            "revoked Bot connection",
        );
        if (resource["lifecycle"] !== "revoked") {
            throw invalid("revoked Bot connection");
        }
        this.botId = nonemptyText(resource, "botId", "revoked Bot connection");
        this.connectionId = nonemptyText(resource, "connectionId", "revoked Bot connection");
        this.lifecycleRevision = integer(resource, "lifecycleRevision", "revoked Bot connection");
        this.revokedAt = timestamp(resource, "revokedAt", "revoked Bot connection");
    }
}

export class MobiusBotDeliveryTarget {
    readonly alias: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly createdAt: string;
    readonly deliveryTargetId: string;
    readonly lifecycle = "active";
    readonly lifecycleRevision: number;
    readonly outboundPolicyRevision: number;
    readonly ownerApproved: boolean;

    constructor(value: unknown) {
        const resource = record(value, "Bot delivery target");
        exact(
            resource,
            [
                "alias",
                "botId",
                "connectionId",
                "createdAt",
                "deliveryTargetId",
                "lifecycle",
                "lifecycleRevision",
                "outboundPolicyRevision",
                "ownerApproved",
            ],
            "Bot delivery target",
        );
        if (resource["lifecycle"] !== "active") {
            throw invalid("Bot delivery target");
        }
        this.alias = nonemptyText(resource, "alias", "Bot delivery target");
        this.botId = nonemptyText(resource, "botId", "Bot delivery target");
        this.connectionId = nonemptyText(resource, "connectionId", "Bot delivery target");
        this.createdAt = timestamp(resource, "createdAt", "Bot delivery target");
        this.deliveryTargetId = nonemptyText(resource, "deliveryTargetId", "Bot delivery target");
        this.lifecycleRevision = integer(resource, "lifecycleRevision", "Bot delivery target");
        this.outboundPolicyRevision = integer(resource, "outboundPolicyRevision", "Bot delivery target");
        this.ownerApproved = boolean(resource, "ownerApproved", "Bot delivery target");
    }
}

export class MobiusDisabledBotDeliveryTarget {
    readonly connectionId: string;
    readonly deliveryTargetId: string;
    readonly disabledAt: string;
    readonly lifecycle = "disabled";

    constructor(value: unknown) {
        const resource = record(value, "disabled Bot delivery target");
        exact(
            resource,
            ["connectionId", "deliveryTargetId", "disabledAt", "lifecycle"],
            "disabled Bot delivery target",
        );
        if (resource["lifecycle"] !== "disabled") {
            throw invalid("disabled Bot delivery target");
        }
        this.connectionId = nonemptyText(resource, "connectionId", "disabled Bot delivery target");
        this.deliveryTargetId = nonemptyText(resource, "deliveryTargetId", "disabled Bot delivery target");
        this.disabledAt = timestamp(resource, "disabledAt", "disabled Bot delivery target");
    }
}

export class MobiusConnectedBotConversation {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly clientConversationKey: string;
    readonly connectionId: string;
    readonly conversationId: string;
    readonly createdAt: string;
    readonly creatorKind = "connection";
    readonly creatorPrincipalId: string;
    readonly lifecycle = "active";
    readonly replyDeliveryTargetId: string;
    readonly sessionId: string;
    readonly title: string;

    constructor(value: unknown) {
        const resource = record(value, "connected Bot conversation");
        exact(
            resource,
            [
                "behaviorRevisionId",
                "bindingId",
                "bindingRevision",
                "botId",
                "clientConversationKey",
                "connectionId",
                "conversationId",
                "createdAt",
                "creatorKind",
                "creatorPrincipalId",
                "lifecycle",
                "replyDeliveryTargetId",
                "sessionId",
                "title",
            ],
            "connected Bot conversation",
        );
        if (resource["creatorKind"] !== "connection" || resource["lifecycle"] !== "active") {
            throw invalid("connected Bot conversation");
        }
        this.behaviorRevisionId = nonemptyText(resource, "behaviorRevisionId", "connected Bot conversation");
        this.bindingId = nonemptyText(resource, "bindingId", "connected Bot conversation");
        this.bindingRevision = integer(resource, "bindingRevision", "connected Bot conversation");
        this.botId = nonemptyText(resource, "botId", "connected Bot conversation");
        this.clientConversationKey = nonemptyText(resource, "clientConversationKey", "connected Bot conversation");
        this.connectionId = nonemptyText(resource, "connectionId", "connected Bot conversation");
        this.conversationId = nonemptyText(resource, "conversationId", "connected Bot conversation");
        this.createdAt = timestamp(resource, "createdAt", "connected Bot conversation");
        this.creatorPrincipalId = nonemptyText(resource, "creatorPrincipalId", "connected Bot conversation");
        this.replyDeliveryTargetId = nonemptyText(resource, "replyDeliveryTargetId", "connected Bot conversation");
        this.sessionId = nonemptyText(resource, "sessionId", "connected Bot conversation");
        this.title = text(resource, "title", "connected Bot conversation");
    }
}

export class MobiusBotTurnAcceptance {
    readonly duplicate: boolean;
    readonly eventCursor: string;
    readonly executionId: string;
    readonly turnId: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot turn acceptance");
        exact(resource, ["duplicate", "eventCursor", "executionId", "turnId"], "Bot turn acceptance");
        this.duplicate = boolean(resource, "duplicate", "Bot turn acceptance");
        this.eventCursor = text(resource, "eventCursor", "Bot turn acceptance");
        this.executionId = nonemptyText(resource, "executionId", "Bot turn acceptance");
        this.turnId = nonemptyText(resource, "turnId", "Bot turn acceptance");
    }
}

export class MobiusBotTurnCancellationAcceptance {
    readonly duplicate: boolean;
    readonly turnId: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot turn cancellation acceptance");
        exact(resource, ["duplicate", "turnId"], "Bot turn cancellation acceptance");
        this.duplicate = boolean(resource, "duplicate", "Bot turn cancellation acceptance");
        this.turnId = nonemptyText(resource, "turnId", "Bot turn cancellation acceptance");
    }
}

export class MobiusBotConversationEvent {
    readonly behaviorRevisionId: string;
    readonly conversationId: string;
    readonly eventId: string;
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly sequence: string;
    readonly timestamp: string;
    readonly turnId: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot conversation event");
        exact(
            resource,
            ["behaviorRevisionId", "conversationId", "eventId", "kind", "payload", "sequence", "timestamp", "turnId"],
            "Bot conversation event",
        );
        this.behaviorRevisionId = nonemptyText(resource, "behaviorRevisionId", "Bot conversation event");
        this.conversationId = nonemptyText(resource, "conversationId", "Bot conversation event");
        this.eventId = nonemptyText(resource, "eventId", "Bot conversation event");
        this.kind = nonemptyText(resource, "kind", "Bot conversation event");
        this.payload = Object.freeze({ ...record(resource["payload"], "Bot conversation event payload") });
        this.sequence = nonemptyText(resource, "sequence", "Bot conversation event");
        this.timestamp = timestamp(resource, "timestamp", "Bot conversation event");
        this.turnId = nonemptyText(resource, "turnId", "Bot conversation event");
    }
}

export class MobiusBotConversationEventPage {
    readonly cursor: string;
    readonly events: readonly MobiusBotConversationEvent[];
    readonly hasMore: boolean;

    constructor(value: unknown) {
        const resource = record(value, "Bot conversation event page");
        exact(resource, ["cursor", "events", "hasMore"], "Bot conversation event page");
        const events = resource["events"];
        if (!Array.isArray(events)) {
            throw invalid("Bot conversation event page");
        }
        this.cursor = text(resource, "cursor", "Bot conversation event page");
        this.events = Object.freeze(events.map((event) => new MobiusBotConversationEvent(event)));
        this.hasMore = boolean(resource, "hasMore", "Bot conversation event page");
    }
}

export class MobiusBotOutboundEvent {
    readonly acceptedAt: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly claimDeadlineAt: string;
    readonly claimId: string;
    readonly conversationId: string;
    readonly deliveryTargetId: string;
    readonly eventId: string;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly outboundMessageId: string;
    readonly sequence: number;
    readonly text: string;
    readonly timestamp: string;
    readonly turnId: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot outbound event");
        exact(
            resource,
            [
                "acceptedAt",
                "behaviorRevisionId",
                "bindingId",
                "bindingRevision",
                "botId",
                "claimDeadlineAt",
                "claimId",
                "conversationId",
                "deliveryTargetId",
                "eventId",
                "executionId",
                "expiresAt",
                "idempotencyKey",
                "outboundMessageId",
                "sequence",
                "text",
                "timestamp",
                "turnId",
            ],
            "Bot outbound event",
        );
        this.acceptedAt = timestamp(resource, "acceptedAt", "Bot outbound event");
        this.behaviorRevisionId = nonemptyText(resource, "behaviorRevisionId", "Bot outbound event");
        this.bindingId = nonemptyText(resource, "bindingId", "Bot outbound event");
        this.bindingRevision = integer(resource, "bindingRevision", "Bot outbound event");
        this.botId = nonemptyText(resource, "botId", "Bot outbound event");
        this.claimDeadlineAt = timestamp(resource, "claimDeadlineAt", "Bot outbound event");
        this.claimId = nonemptyText(resource, "claimId", "Bot outbound event");
        this.conversationId = nonemptyText(resource, "conversationId", "Bot outbound event");
        this.deliveryTargetId = nonemptyText(resource, "deliveryTargetId", "Bot outbound event");
        this.eventId = nonemptyText(resource, "eventId", "Bot outbound event");
        this.executionId = nonemptyText(resource, "executionId", "Bot outbound event");
        this.expiresAt = timestamp(resource, "expiresAt", "Bot outbound event");
        this.idempotencyKey = nonemptyText(resource, "idempotencyKey", "Bot outbound event");
        this.outboundMessageId = nonemptyText(resource, "outboundMessageId", "Bot outbound event");
        this.sequence = integer(resource, "sequence", "Bot outbound event");
        this.text = nonemptyText(resource, "text", "Bot outbound event");
        this.timestamp = timestamp(resource, "timestamp", "Bot outbound event");
        this.turnId = nonemptyText(resource, "turnId", "Bot outbound event");
    }
}

export class MobiusBotOutboundEventPage {
    readonly cursor: number;
    readonly events: readonly MobiusBotOutboundEvent[];

    constructor(value: unknown) {
        const resource = record(value, "Bot outbound event page");
        exact(resource, ["cursor", "events"], "Bot outbound event page");
        const events = resource["events"];
        if (!Array.isArray(events)) {
            throw invalid("Bot outbound event page");
        }
        this.cursor = integer(resource, "cursor", "Bot outbound event page");
        this.events = Object.freeze(events.map((event) => new MobiusBotOutboundEvent(event)));
    }
}

export class MobiusBotDeliveryAcknowledgement {
    readonly duplicate: boolean;
    readonly outboundMessageId: string;
    readonly state: string;

    constructor(value: unknown) {
        const resource = record(value, "Bot delivery acknowledgement");
        exact(resource, ["duplicate", "outboundMessageId", "state"], "Bot delivery acknowledgement");
        this.duplicate = boolean(resource, "duplicate", "Bot delivery acknowledgement");
        this.outboundMessageId = nonemptyText(resource, "outboundMessageId", "Bot delivery acknowledgement");
        this.state = nonemptyText(resource, "state", "Bot delivery acknowledgement");
        if (!["delivered", "retryable_failed", "terminal_failed"].includes(this.state)) {
            throw invalid("Bot delivery acknowledgement");
        }
    }
}
