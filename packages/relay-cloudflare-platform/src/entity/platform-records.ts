import { PROJECT_LOCATION_HINTS } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const lifecycle = v.picklist(["active", "deleted"]);

export const AppRowSchema = v.object({
    app_id: v.string(),
    created_at: nonNegativeInteger,
    // Legacy column name for the credential issued at App creation, unchanged by rotation or revocation.
    default_credential_id: v.nullable(v.string()),
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    lifecycle,
    tenant_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type AppRow = Readonly<v.InferOutput<typeof AppRowSchema>>;

export const AuditRowSchema = v.object({
    action: v.string(),
    actor_id: v.string(),
    actor_kind: v.string(),
    actor_ref: v.string(),
    app_id: v.string(),
    audit_id: v.string(),
    details_json: v.string(),
    outcome: v.picklist(["succeeded", "denied"]),
    project_id: v.string(),
    recorded_at: nonNegativeInteger,
    subject_id: v.string(),
    tenant_id: v.string(),
});
export type AuditRow = Readonly<v.InferOutput<typeof AuditRowSchema>>;

export const CredentialRowSchema = v.object({
    all_projects: v.picklist([0, 1]),
    app_id: v.string(),
    credential_id: v.string(),
    issued_at: nonNegativeInteger,
    overlap_ends_at: v.nullable(nonNegativeInteger),
    permissions_json: v.string(),
    public_credential_id: v.string(),
    replaced_by_credential_id: v.nullable(v.string()),
    revoked_at: v.nullable(nonNegativeInteger),
    secret_digest: v.string(),
    tenant_id: v.string(),
});
export type CredentialRow = Readonly<v.InferOutput<typeof CredentialRowSchema>>;

export interface PlatformAppCredentialInsert {
    readonly allProjects: boolean;
    readonly appId: string;
    readonly credentialId: string;
    readonly issuedAt: number;
    readonly permissionsJson: string;
    readonly publicCredentialId: string;
    readonly secretDigest: string;
}

export interface PlatformAuditRecord {
    readonly action: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorRef: string;
    readonly appId: string;
    readonly auditId: string;
    readonly detailsJson: string;
    readonly outcome: string;
    readonly projectId: string;
    readonly recordedAt: number;
    readonly subjectId: string;
    readonly tenantId: string;
}

export const PlatformProjectScopeRowSchema = v.object({
    app_id: v.string(),
    lifecycle,
    project_id: v.string(),
    tenant_id: v.string(),
});
export type PlatformProjectScopeRow = Readonly<v.InferOutput<typeof PlatformProjectScopeRowSchema>>;

export const ProjectRowSchema = v.object({
    app_id: v.string(),
    client_reference: v.string(),
    created_at: nonNegativeInteger,
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    idempotency_key: v.string(),
    lifecycle,
    location_hint: v.picklist(PROJECT_LOCATION_HINTS),
    project_id: v.string(),
    request_digest: v.string(),
    tenant_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type ProjectRow = Readonly<v.InferOutput<typeof ProjectRowSchema>>;

export const RecordPresenceRowSchema = v.object({ present: v.literal(1) });
export type RecordPresenceRow = Readonly<v.InferOutput<typeof RecordPresenceRowSchema>>;

export const ProjectStorageScopeRowSchema = v.object({ created_at: v.number() });

export const TenantRowSchema = v.object({
    created_at: nonNegativeInteger,
    display_name: v.string(),
    quotas_json: v.string(),
    tenant_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type TenantRow = Readonly<v.InferOutput<typeof TenantRowSchema>>;
