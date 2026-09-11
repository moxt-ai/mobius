import * as v from "valibot";

const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const lifecycle = v.picklist(["active", "suspended", "deleted"]);

export const ConversationCredentialRowSchema = v.object({
    actor_ref: v.string(),
    app_id: v.string(),
    app_lifecycle: lifecycle,
    conversation_id: v.string(),
    credential_id: v.string(),
    expires_at: timestamp,
    parent_credential_id: v.string(),
    parent_credential_revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    parent_expires_at: timestamp,
    parent_overlap_ends_at: v.nullable(timestamp),
    parent_replaced_by_credential_id: v.nullable(v.string()),
    parent_revoked_at: v.nullable(timestamp),
    parent_revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    permissions_json: v.string(),
    project_id: v.string(),
    project_lifecycle: lifecycle,
    public_credential_id: v.string(),
    revoked_at: v.nullable(timestamp),
    secret_digest: v.string(),
    session_id: v.string(),
    tenant_id: v.string(),
    tenant_lifecycle: lifecycle,
});
export type ConversationCredentialRow = Readonly<v.InferOutput<typeof ConversationCredentialRowSchema>>;

export interface ConversationCredentialInsert {
    readonly actorRef: string;
    readonly appId: string;
    readonly conversationId: string;
    readonly credentialId: string;
    readonly expiresAt: number;
    readonly issuedAt: number;
    readonly parentCredentialId: string;
    readonly parentCredentialRevision: number;
    readonly permissionsJson: string;
    readonly projectId: string;
    readonly publicCredentialId: string;
    readonly secretDigest: string;
    readonly sessionId: string;
    readonly tenantId: string;
}

export const ConversationDirectoryRowSchema = v.object({
    conversation_id: v.string(),
    project_id: v.string(),
    session_id: v.string(),
    tenant_id: v.string(),
});
export type ConversationDirectoryRow = Readonly<v.InferOutput<typeof ConversationDirectoryRowSchema>>;

export interface ConversationMessageInsert {
    readonly actorRef: string;
    readonly artifactIdsJson: string;
    readonly content: string;
    readonly conversationId: string;
    readonly createdAt: number;
    readonly credentialId: string;
    readonly idempotencyKey: string;
    readonly imagesJson: string;
    readonly messageId: string;
    readonly projectId: string;
    readonly requestDigest: string;
    readonly resourcesJson: string;
    readonly sessionId: string;
}

export const ConversationMessageRowSchema = v.object({
    actor_ref: v.string(),
    artifact_ids_json: v.string(),
    content: v.string(),
    conversation_id: v.string(),
    created_at: timestamp,
    credential_id: v.string(),
    idempotency_key: v.string(),
    images_json: v.string(),
    message_id: v.string(),
    project_id: v.string(),
    request_digest: v.string(),
    resources_json: v.string(),
    session_id: v.string(),
});
export type ConversationMessageRow = Readonly<v.InferOutput<typeof ConversationMessageRowSchema>>;
