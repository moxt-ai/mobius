import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { type OrganizationInviteRow, organizationInviteRowSchema } from "../entity/organization-invite.ts";
import { platformDashboardAuditEvent, platformOrganizationInviteLink } from "../schema/index.ts";
import { decodeOptionalStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";
import { type PlatformDrizzleDatabase, platformDrizzle } from "./platform-drizzle-database.ts";

const inviteSelection = {
    id: platformOrganizationInviteLink.id,
    organization_id: platformOrganizationInviteLink.organizationId,
    token_hash: platformOrganizationInviteLink.tokenHash,
    creator_id: platformOrganizationInviteLink.creatorId,
    created_at: platformOrganizationInviteLink.createdAt,
    expires_at: platformOrganizationInviteLink.expiresAt,
    revoked_at: platformOrganizationInviteLink.revokedAt,
};

export class OrganizationInviteStorage {
    private readonly database: PlatformDrizzleDatabase;
    constructor(database: D1Database) {
        this.database = platformDrizzle(database);
    }

    private readonly audit = (organizationId: string, actor: string, id: string, action: string, now: number) =>
        this.database.insert(platformDashboardAuditEvent).values({
            auditId: crypto.randomUUID(),
            tenantId: organizationId,
            appId: "",
            projectId: "",
            actorKind: "developer",
            actorId: actor,
            actorRef: "",
            action,
            subjectId: id,
            outcome: "succeeded",
            detailsJson: "{}",
            recordedAt: now,
        });

    readonly create = async (row: OrganizationInviteRow, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.database.batch([
            this.database.insert(platformOrganizationInviteLink).values({
                id: row.id,
                organizationId: row.organization_id,
                tokenHash: row.token_hash,
                creatorId: row.creator_id,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
            }),
            this.audit(row.organization_id, row.creator_id, row.id, "organization_invite.created", row.created_at),
        ]);
        signal.throwIfAborted();
    };

    readonly list = async (id: string, now: number, signal: AbortSignal): Promise<readonly OrganizationInviteRow[]> => {
        signal.throwIfAborted();
        const rows = await this.database
            .select(inviteSelection)
            .from(platformOrganizationInviteLink)
            .where(
                and(
                    eq(platformOrganizationInviteLink.organizationId, id),
                    isNull(platformOrganizationInviteLink.revokedAt),
                    gt(platformOrganizationInviteLink.expiresAt, now),
                ),
            )
            .orderBy(desc(platformOrganizationInviteLink.createdAt))
            .limit(100);
        signal.throwIfAborted();
        return decodeStorageRecords(organizationInviteRowSchema, rows);
    };

    readonly find = async (hash: string, signal: AbortSignal): Promise<OrganizationInviteRow | null> => {
        signal.throwIfAborted();
        const [row] = await this.database
            .select(inviteSelection)
            .from(platformOrganizationInviteLink)
            .where(eq(platformOrganizationInviteLink.tokenHash, hash))
            .limit(1);
        signal.throwIfAborted();
        return decodeOptionalStorageRecord(organizationInviteRowSchema, row ?? null);
    };

    readonly revoke = async (
        organizationId: string,
        id: string,
        actor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.database.batch([
            this.database
                .update(platformOrganizationInviteLink)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(platformOrganizationInviteLink.organizationId, organizationId),
                        eq(platformOrganizationInviteLink.id, id),
                        isNull(platformOrganizationInviteLink.revokedAt),
                    ),
                ),
            this.audit(organizationId, actor, id, "organization_invite.revoked", now),
        ]);
        signal.throwIfAborted();
    };

    readonly accepted = async (
        row: OrganizationInviteRow,
        actor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.audit(row.organization_id, actor, row.id, "organization_invite.accepted", now);
        signal.throwIfAborted();
    };
}
