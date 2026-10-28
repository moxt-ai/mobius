import type { VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import type { OrganizationMembershipGateway } from "../infra/organization-membership-gateway.ts";

/**
 * Decides whether a developer administers an organization. Clerk's current membership is the only source: a role
 * claim in an older token is not consulted, so a demotion applies at the next check. A failed lookup throws.
 */
export class OrganizationAdministrators {
    readonly #clerk: OrganizationMembershipGateway;

    constructor(clerk: OrganizationMembershipGateway) {
        this.#clerk = clerk;
    }

    /** The administering Clerk user, or null when the identity is not a current admin of this organization. */
    readonly administrator = async (
        identity: VerifiedExternalIdentity,
        organizationId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        if (
            identity.providerId !== "clerk" ||
            identity.organization.kind !== "organization" ||
            identity.organization.id !== organizationId
        ) {
            return null;
        }
        return (await this.#clerk.role(organizationId, identity.subject, signal)) === "org:admin"
            ? identity.subject
            : null;
    };
}
