import type { VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";
import { type OrganizationInviteRow, organizationInviteTokenSchema } from "../entity/organization-invite.ts";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { OrganizationMembershipGateway } from "../infra/organization-membership-gateway.ts";
import type { OrganizationInviteStorage } from "../storage/organization-invite-storage.ts";
import type { OrganizationAdministrators } from "./organization-administrators.ts";

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function digest(token: string): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
function resource(row: OrganizationInviteRow) {
    return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, role: "org:member" };
}

export class OrganizationInviteService {
    private readonly storage: OrganizationInviteStorage;
    private readonly clerk: OrganizationMembershipGateway;
    private readonly administrators: OrganizationAdministrators;
    constructor(
        storage: OrganizationInviteStorage,
        clerk: OrganizationMembershipGateway,
        administrators: OrganizationAdministrators,
    ) {
        this.storage = storage;
        this.clerk = clerk;
        this.administrators = administrators;
    }

    private readonly user = (identity: VerifiedExternalIdentity): string => {
        if (identity.providerId !== "clerk" || !/^user_[a-zA-Z0-9]+$/.test(identity.subject)) {
            throw new PlatformControlPlaneError("clerk_required", "Sign in with Clerk to use this invitation", 403);
        }
        return identity.subject;
    };

    private readonly admin = async (
        identity: VerifiedExternalIdentity,
        organizationId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const userId = this.user(identity);
        if (!/^org_[a-zA-Z0-9]+$/.test(organizationId)) {
            throw new PlatformControlPlaneError("invalid_request", "Invalid organization", 400);
        }
        if ((await this.administrators.administrator(identity, organizationId, signal)) === null) {
            throw new PlatformControlPlaneError(
                "organization_admin_required",
                "An organization admin is required",
                403,
            );
        }
        return userId;
    };

    readonly create = async (identity: VerifiedExternalIdentity, organizationId: string, signal: AbortSignal) => {
        const creator = await this.admin(identity, organizationId, signal);
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        const now = Date.now();
        const row = {
            id: crypto.randomUUID(),
            organization_id: organizationId,
            token_hash: await digest(token),
            creator_id: creator,
            created_at: now,
            expires_at: now + 7 * 24 * 60 * 60 * 1000,
            revoked_at: null,
        };
        await this.storage.create(row, signal);
        return { ...resource(row), token };
    };

    readonly list = async (identity: VerifiedExternalIdentity, organizationId: string, signal: AbortSignal) => {
        await this.admin(identity, organizationId, signal);
        return (await this.storage.list(organizationId, Date.now(), signal)).map(resource);
    };

    readonly revoke = async (
        identity: VerifiedExternalIdentity,
        organizationId: string,
        id: string,
        signal: AbortSignal,
    ) => {
        const actor = await this.admin(identity, organizationId, signal);
        if (!/^[a-f0-9-]{36}$/.test(id)) {
            throw new PlatformControlPlaneError("invalid_request", "Invalid invitation", 400);
        }
        const revoked = await this.storage.revoke(organizationId, id, actor, Date.now(), signal);
        return { revoked };
    };

    private readonly resolve = async (token: string, signal: AbortSignal) => {
        if (!v.safeParse(organizationInviteTokenSchema, token).success) {
            throw new PlatformControlPlaneError("invalid_request", "Invalid invitation", 400);
        }
        const row = await this.storage.find(await digest(token), signal);
        if (row === null || row.revoked_at !== null || row.expires_at <= Date.now()) {
            throw new PlatformControlPlaneError(
                "invite_link_unavailable",
                "This invite link has expired or been revoked. Ask an admin for a new link",
                410,
            );
        }
        return row;
    };

    readonly preview = async (identity: VerifiedExternalIdentity, token: string, signal: AbortSignal) => {
        const userId = this.user(identity);
        const row = await this.resolve(token, signal);
        const organization = await this.clerk.organization(row.organization_id, signal);
        return {
            organizationId: organization.id,
            organizationName: organization.name,
            member: (await this.clerk.role(organization.id, userId, signal)) !== null,
        };
    };

    readonly accept = async (identity: VerifiedExternalIdentity, token: string, signal: AbortSignal) => {
        const userId = this.user(identity);
        const row = await this.resolve(token, signal);
        const organization = await this.clerk.organization(row.organization_id, signal);
        // Recheck validity immediately before the external membership side effect.
        await this.resolve(token, signal);
        const acceptance = await this.clerk.join(organization.id, userId, row.id, signal);
        if (acceptance !== null) {
            await this.storage.accepted(row, userId, acceptance, signal);
        }
        return { organizationId: organization.id, organizationName: organization.name, member: true };
    };
}
