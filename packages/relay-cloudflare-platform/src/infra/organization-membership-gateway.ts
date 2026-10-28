import type { OrganizationInviteAcceptance } from "../entity/organization-invite.ts";

export interface OrganizationMembershipGateway {
    readonly organization: (
        organizationId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly id: string; readonly name: string }>;
    readonly role: (organizationId: string, userId: string, signal: AbortSignal) => Promise<string | null>;
    /** Returns the creation receipt only for a membership created through this invite, including retries. */
    readonly join: (
        organizationId: string,
        userId: string,
        inviteId: string,
        signal: AbortSignal,
    ) => Promise<OrganizationInviteAcceptance | null>;
}
