import type { ProjectScope } from "../do/session.ts";
import type { ProjectAccessLifetime } from "./project-authentication.ts";

export class ConversationPermission {
    static readonly ArtifactRead = new ConversationPermission("artifact:read");
    static readonly ArtifactWrite = new ConversationPermission("artifact:write");
    static readonly Configure = new ConversationPermission("conversation:configure");
    static readonly EventRead = new ConversationPermission("conversation:event:read");
    static readonly InteractionRespond = new ConversationPermission("interaction:respond");
    static readonly MessageCreate = new ConversationPermission("conversation:message:create");
    static readonly Read = new ConversationPermission("conversation:read");
    static readonly TurnCancel = new ConversationPermission("conversation:turn:cancel");
    static readonly TurnCreate = new ConversationPermission("conversation:turn:create");

    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export const CONVERSATION_PERMISSIONS: readonly ConversationPermission[] = Object.freeze([
    ConversationPermission.ArtifactRead,
    ConversationPermission.ArtifactWrite,
    ConversationPermission.Configure,
    ConversationPermission.EventRead,
    ConversationPermission.InteractionRespond,
    ConversationPermission.MessageCreate,
    ConversationPermission.Read,
    ConversationPermission.TurnCancel,
    ConversationPermission.TurnCreate,
]);

export function decodeConversationPermissions(value: unknown): ReadonlySet<ConversationPermission> {
    if (!Array.isArray(value) || value.length === 0 || value.length > CONVERSATION_PERMISSIONS.length) {
        throw new ConversationAccessError(
            "conversation_permission_invalid",
            "The Conversation permissions are invalid",
        );
    }
    const result = new Set<ConversationPermission>();
    for (const candidate of value) {
        if (typeof candidate !== "string") {
            throw new ConversationAccessError(
                "conversation_permission_invalid",
                "The Conversation permissions are invalid",
            );
        }
        const permission = CONVERSATION_PERMISSIONS.find((entry) => entry.value === candidate);
        if (permission === undefined || result.has(permission)) {
            throw new ConversationAccessError(
                "conversation_permission_invalid",
                "The Conversation permissions are invalid",
            );
        }
        result.add(permission);
    }
    return result;
}

export class ConversationAccessContext {
    readonly actorReference: string;
    readonly conversationId: string;
    readonly credentialId: string;
    readonly lifetime: ProjectAccessLifetime;
    readonly permissions: ReadonlySet<ConversationPermission>;
    readonly scope: ProjectScope;
    readonly sessionId: string;

    constructor(
        scope: ProjectScope,
        conversationId: string,
        sessionId: string,
        credentialId: string,
        actorReference: string,
        permissions: ReadonlySet<ConversationPermission>,
        lifetime: ProjectAccessLifetime,
    ) {
        this.scope = scope;
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.credentialId = credentialId;
        this.actorReference = actorReference;
        this.permissions = new Set(permissions);
        this.lifetime = lifetime;
    }

    readonly require = (permission: ConversationPermission): void => {
        if (!this.permissions.has(permission)) {
            throw new ConversationAccessError(
                "conversation_permission_denied",
                "The Conversation credential does not grant this operation",
            );
        }
    };
}

export class ConversationAccessError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ConversationAccessError";
    }
}

export interface ConversationAccessAuthorizer {
    readonly authorize: (
        credential: string,
        requiredPermission: ConversationPermission,
        signal: AbortSignal,
    ) => Promise<ConversationAccessContext>;
}
