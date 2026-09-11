import type { ConversationAccessContext } from "../authentication/conversation-access.ts";
import {
    AuditActor,
    AuditActorKind,
    BotConnectionAccessContext,
    type ProjectAccessContext,
    RuntimeAccessContext,
} from "../authentication/project-authentication.ts";
import { ProjectScope } from "../do/session.ts";

export interface BotConnectorCredential {
    readonly audience: string;
    readonly bot_id: string;
    readonly connection_id: string;
    readonly connector_principal_id: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly scopes_json: string;
}

export interface BotRuntimeCredential {
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly bot_lifecycle: string;
    readonly capability_id: string;
    readonly channel_id: string;
    readonly conversation_id: string;
    readonly execution_id: string;
    readonly local_grant_id: string;
    readonly pairing_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly session_id: string;
    readonly turn_id: string;
}

export class ProjectBotAccess {
    readonly actor: AuditActor;
    readonly botId: string;
    readonly conversationActorKind = "owner";
    readonly credentialId: string;
    readonly scope: ProjectScope;

    constructor(access: ProjectAccessContext, botId: string) {
        this.scope = access.scope;
        this.credentialId = access.credentialId;
        this.actor = access.actor;
        this.botId = botId;
    }
}

export class ProjectConversationAccess extends ProjectBotAccess {
    readonly conversationId: string;
    readonly sessionId: string;

    constructor(access: ProjectAccessContext, botId: string, conversationId: string, sessionId: string) {
        super(access, botId);
        this.conversationId = conversationId;
        this.sessionId = sessionId;
    }
}

export class ConversationBotAccess {
    readonly actor: AuditActor;
    readonly botId: string;
    readonly conversationActorKind = "owner";
    readonly credentialId: string;
    readonly scope: ProjectScope;

    constructor(access: ConversationAccessContext, botId: string) {
        this.scope = access.scope;
        this.credentialId = access.credentialId;
        this.actor = new AuditActor(AuditActorKind.BrowserAccess, access.actorReference);
        this.botId = botId;
    }
}

export class BotConnectionAccess extends BotConnectionAccessContext {
    readonly actor: AuditActor;
    readonly conversationActorKind = "connection";
    readonly connectorPrincipalId: string;

    constructor(
        scope: ProjectScope,
        botId: string,
        connectionId: string,
        credentialId: string,
        connectorPrincipalId: string,
        audience: string,
        scopes: readonly string[],
    ) {
        super(
            scope,
            botId,
            connectionId,
            credentialId,
            new AuditActor(AuditActorKind.BotConnection, connectorPrincipalId),
            audience,
            new Set(scopes),
        );
        this.actor = this.connectorActor;
        this.connectorPrincipalId = connectorPrincipalId;
    }
}

export interface BotConversationAuthorization {
    readonly actor: AuditActor;
    readonly botId: string;
    readonly conversationActorKind: string;
    readonly scope: ProjectScope;
}

export class BotRuntimeExecutionAccess extends RuntimeAccessContext {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly localGrantId: string;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(row: BotRuntimeCredential) {
        super(
            new ProjectScope(row.project_id),
            row.runtime_id,
            row.channel_id,
            `daemon:${row.channel_id}`,
            row.pairing_id,
        );
        this.executionId = row.execution_id;
        this.botId = row.bot_id;
        this.conversationId = row.conversation_id;
        this.turnId = row.turn_id;
        this.sessionId = row.session_id;
        this.behaviorRevisionId = row.behavior_revision_id;
        this.bindingId = row.binding_id;
        this.bindingRevision = row.binding_revision;
        this.capabilityId = row.capability_id;
        this.localGrantId = row.local_grant_id;
    }
}
