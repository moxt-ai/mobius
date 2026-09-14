import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const lifecycle = v.picklist(["active", "suspended", "deleted"]);

export const ActiveCountRowSchema = v.object({ active_count: nonNegativeInteger });
export type ActiveCountRow = Readonly<v.InferOutput<typeof ActiveCountRowSchema>>;

export const AppRowSchema = v.object({
    app_id: v.string(),
    created_at: nonNegativeInteger,
    default_credential_id: v.nullable(v.string()),
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    lifecycle,
    suspended_at: v.nullable(nonNegativeInteger),
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

export const CredentialRevisionRowSchema = v.object({ revision: positiveInteger });
export type CredentialRevisionRow = Readonly<v.InferOutput<typeof CredentialRevisionRowSchema>>;

export const CredentialRowSchema = v.object({
    all_projects: v.picklist([0, 1]),
    app_id: v.string(),
    app_lifecycle: v.string(),
    credential_id: v.string(),
    issued_at: nonNegativeInteger,
    last_used_at: nonNegativeInteger,
    overlap_ends_at: v.nullable(nonNegativeInteger),
    permissions_json: v.string(),
    public_credential_id: v.string(),
    replaced_by_credential_id: v.nullable(v.string()),
    revision: positiveInteger,
    revoked_at: v.nullable(nonNegativeInteger),
    secret_digest: v.string(),
    tenant_id: v.string(),
    tenant_lifecycle: v.string(),
});
export type CredentialRow = Readonly<v.InferOutput<typeof CredentialRowSchema>>;

export const MembershipRowSchema = v.object({
    membership_id: v.string(),
    role: v.picklist(["owner", "developer"]),
    tenant_id: v.string(),
});
export type MembershipRow = Readonly<v.InferOutput<typeof MembershipRowSchema>>;

export interface PlatformAppCredentialInsert {
    readonly allProjects: boolean;
    readonly appId: string;
    readonly credentialId: string;
    readonly issuedAt: number;
    readonly permissionsJson: string;
    readonly publicCredentialId: string;
    readonly revision: number;
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

export interface PlatformDeveloperMembershipInsert {
    readonly createdAt: number;
    readonly issuer: string;
    readonly membershipId: string;
    readonly providerId: string;
    readonly subject: string;
    readonly tenantId: string;
}

export const PlatformProjectScopeRowSchema = v.object({
    app_id: v.string(),
    lifecycle,
    project_id: v.string(),
    tenant_id: v.string(),
});
export type PlatformProjectScopeRow = Readonly<v.InferOutput<typeof PlatformProjectScopeRowSchema>>;

export const ProjectIdRowSchema = v.object({ project_id: v.string() });
export type ProjectIdRow = Readonly<v.InferOutput<typeof ProjectIdRowSchema>>;

export const ProjectRowSchema = v.object({
    app_id: v.string(),
    client_reference: v.string(),
    created_at: nonNegativeInteger,
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    idempotency_key: v.string(),
    lifecycle,
    project_id: v.string(),
    request_digest: v.string(),
    suspended_at: v.nullable(nonNegativeInteger),
    tenant_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type ProjectRow = Readonly<v.InferOutput<typeof ProjectRowSchema>>;

export const RecordPresenceRowSchema = v.object({ present: v.literal(1) });
export type RecordPresenceRow = Readonly<v.InferOutput<typeof RecordPresenceRowSchema>>;

export const TenantRowSchema = v.object({
    created_at: nonNegativeInteger,
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    lifecycle,
    quotas_json: v.string(),
    suspended_at: v.nullable(nonNegativeInteger),
    tenant_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type TenantRow = Readonly<v.InferOutput<typeof TenantRowSchema>>;
