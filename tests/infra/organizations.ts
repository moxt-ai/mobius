import type { OrganizationMembershipGateway } from "../../packages/relay-cloudflare-platform/src/infra/organization-membership-gateway.ts";

/** Stateful Clerk organization boundary shared by Worker and web acceptance scenarios. */
export class TestClerkOrganizations implements OrganizationMembershipGateway {
    readonly members = new Map([["user_admin", "org:admin"]]);
    readonly organization = async (id: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (id !== "org_invites") {
            throw new Error("Unknown test organization");
        }
        return { id, name: "Invite team" };
    };
    readonly role = async (id: string, user: string, signal: AbortSignal) => {
        await this.organization(id, signal);
        return this.members.get(user) ?? null;
    };
    readonly join = async (id: string, user: string, signal: AbortSignal) => {
        await this.organization(id, signal);
        if (!this.members.has(user)) {
            this.members.set(user, "org:member");
        }
    };
}
