import { ProjectScope } from "../do/session.ts";

export interface BotOwnerCredential {
    readonly bot_id: string;
    readonly credential_id: string;
    readonly project_id: string;
    readonly tenant_id: string;
}
export interface ProjectOwnerCredential {
    readonly credential_id: string;
    readonly project_id: string;
    readonly tenant_id: string;
}
export interface BotConnectorCredential {
    readonly audience: string;
    readonly bot_id: string;
    readonly connection_id: string;
    readonly connector_principal_id: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly scopes_json: string;
    readonly tenant_id: string;
}
export interface BotRuntimeCredential {
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly bot_lifecycle: string;
    readonly capability_id: string;
    readonly conversation_id: string;
    readonly execution_id: string;
    readonly local_grant_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly session_id: string;
    readonly tenant_id: string;
    readonly turn_id: string;
}
export class BotOwnerAccess {
    readonly scope: ProjectScope;
    readonly credentialId: string;
    readonly botId: string;
    constructor(scope: ProjectScope, credentialId: string, botId: string) {
        this.scope = scope;
        this.credentialId = credentialId;
        this.botId = botId;
    }
}
export class ProjectOwnerAccess {
    readonly scope: ProjectScope;
    readonly credentialId: string;
    constructor(scope: ProjectScope, credentialId: string) {
        this.scope = scope;
        this.credentialId = credentialId;
    }
}
export class BotConnectorAccess {
    readonly scope: ProjectScope;
    readonly botId: string;
    readonly connectionId: string;
    readonly credentialId: string;
    readonly connectorPrincipalId: string;
    readonly audience: string;
    readonly scopes: readonly string[];
    constructor(
        scope: ProjectScope,
        botId: string,
        connectionId: string,
        credentialId: string,
        connectorPrincipalId: string,
        audience: string,
        scopes: readonly string[],
    ) {
        this.scope = scope;
        this.botId = botId;
        this.connectionId = connectionId;
        this.credentialId = credentialId;
        this.connectorPrincipalId = connectorPrincipalId;
        this.audience = audience;
        this.scopes = Object.freeze([...scopes]);
    }
}
export abstract class InboundBotPrincipal {
    abstract readonly kind: string;
    readonly scope: ProjectScope;
    readonly botId: string;
    readonly principalId: string;
    protected constructor(scope: ProjectScope, botId: string, principalId: string) {
        this.scope = scope;
        this.botId = botId;
        this.principalId = principalId;
    }
}
export class InboundBotOwnerPrincipal extends InboundBotPrincipal {
    readonly kind = "owner";
    constructor(access: BotOwnerAccess) {
        super(access.scope, access.botId, access.credentialId);
    }
}
export class InboundBotConnectorPrincipal extends InboundBotPrincipal {
    readonly kind = "connection";
    readonly connection: BotConnectorAccess;
    constructor(connection: BotConnectorAccess) {
        super(connection.scope, connection.botId, connection.connectorPrincipalId);
        this.connection = connection;
    }
}
export class BotRuntimeExecutionAccess {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly localGrantId: string;
    readonly runtimeId: string;
    readonly scope: ProjectScope;
    readonly sessionId: string;
    readonly turnId: string;
    constructor(row: BotRuntimeCredential) {
        this.scope = new ProjectScope(row.tenant_id, row.project_id);
        this.executionId = row.execution_id;
        this.botId = row.bot_id;
        this.conversationId = row.conversation_id;
        this.turnId = row.turn_id;
        this.sessionId = row.session_id;
        this.behaviorRevisionId = row.behavior_revision_id;
        this.bindingId = row.binding_id;
        this.bindingRevision = row.binding_revision;
        this.runtimeId = row.runtime_id;
        this.capabilityId = row.capability_id;
        this.localGrantId = row.local_grant_id;
    }
}
