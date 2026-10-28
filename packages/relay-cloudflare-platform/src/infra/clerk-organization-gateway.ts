import * as v from "valibot";
import type { OrganizationInviteAcceptance } from "../entity/organization-invite.ts";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { OrganizationMembershipGateway } from "./organization-membership-gateway.ts";

const organizationSchema = v.object({
    id: v.pipe(v.string(), v.regex(/^org_[a-zA-Z0-9]+$/)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
const membershipSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    role: v.string(),
    public_user_data: v.object({ user_id: v.string() }),
    private_metadata: v.optional(v.unknown()),
});
const membershipsSchema = v.object({ data: v.array(membershipSchema) });
const inviteAcceptanceMetadataSchema = v.object({
    mobius_invite_acceptance: v.object({
        version: v.literal(1),
        invite_id: v.pipe(v.string(), v.uuid()),
        actor_id: v.pipe(v.string(), v.regex(/^user_[a-zA-Z0-9]+$/)),
    }),
});

function acceptance(
    membership: v.InferOutput<typeof membershipSchema>,
    inviteId: string,
    userId: string,
): OrganizationInviteAcceptance | null {
    const metadata = v.safeParse(inviteAcceptanceMetadataSchema, membership.private_metadata);
    if (
        !metadata.success ||
        metadata.output.mobius_invite_acceptance.invite_id !== inviteId ||
        metadata.output.mobius_invite_acceptance.actor_id !== userId
    ) {
        return null;
    }
    return { membershipId: membership.id, acceptedAt: membership.created_at };
}

export class ClerkOrganizationGateway implements OrganizationMembershipGateway {
    private readonly secret: string | undefined;
    private readonly transport: typeof fetch;
    constructor(secret: string | undefined, transport: typeof fetch = globalThis.fetch.bind(globalThis)) {
        this.secret = secret;
        this.transport = transport;
    }

    private readonly request = async (path: string, signal: AbortSignal, body?: unknown): Promise<Response> => {
        signal.throwIfAborted();
        if (this.secret === undefined || !/^sk_(test|live)_[a-zA-Z0-9]+$/.test(this.secret)) {
            throw new PlatformControlPlaneError(
                "invite_links_unavailable",
                "Organization invite links are not configured",
                503,
            );
        }
        try {
            return await this.transport(`https://api.clerk.com/v1/organizations/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
                // Workers support only follow/manual. Non-2xx responses are rejected below.
                redirect: "manual",
            });
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformControlPlaneError("clerk_unavailable", "Organization service is unavailable", 503, {
                cause,
            });
        }
    };

    private readonly json = async (response: Response, signal: AbortSignal): Promise<unknown> => {
        try {
            if (!response.ok) {
                await response.body?.cancel();
                throw new PlatformControlPlaneError(
                    "clerk_unavailable",
                    "Organization service could not complete the request",
                    503,
                );
            }
            return await response.json();
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformControlPlaneError(
                "clerk_unavailable",
                "Organization service returned an invalid response",
                503,
                { cause },
            );
        }
    };

    readonly organization = async (id: string, signal: AbortSignal) => {
        const parsed = v.safeParse(
            organizationSchema,
            await this.json(await this.request(encodeURIComponent(id), signal), signal),
        );
        if (!parsed.success || parsed.output.id !== id) {
            throw new PlatformControlPlaneError(
                "clerk_invalid_response",
                "Organization service returned an invalid organization",
                502,
            );
        }
        return parsed.output;
    };

    private readonly membership = async (id: string, userId: string, signal: AbortSignal) => {
        const query = new URLSearchParams({ user_id: userId, limit: "1" });
        const parsed = v.safeParse(
            membershipsSchema,
            await this.json(await this.request(`${encodeURIComponent(id)}/memberships?${query}`, signal), signal),
        );
        if (!parsed.success) {
            throw new PlatformControlPlaneError(
                "clerk_invalid_response",
                "Organization service returned an invalid membership",
                502,
            );
        }
        return parsed.output.data.find((entry) => entry.public_user_data.user_id === userId) ?? null;
    };

    readonly role = async (id: string, userId: string, signal: AbortSignal): Promise<string | null> =>
        (await this.membership(id, userId, signal))?.role ?? null;

    readonly join = async (
        id: string,
        userId: string,
        inviteId: string,
        signal: AbortSignal,
    ): Promise<OrganizationInviteAcceptance | null> => {
        const existing = await this.membership(id, userId, signal);
        if (existing !== null) {
            return acceptance(existing, inviteId, userId);
        }
        const response = await this.request(`${encodeURIComponent(id)}/memberships`, signal, {
            user_id: userId,
            role: "org:member",
            // Store provenance with the external side effect so a failed audit can be retried truthfully.
            private_metadata: { mobius_invite_acceptance: { version: 1, invite_id: inviteId, actor_id: userId } },
        });
        // A concurrent redemption may have already created the membership. Never change an existing role.
        if (!response.ok) {
            await response.body?.cancel();
            const concurrent = await this.membership(id, userId, signal);
            if (concurrent !== null) {
                return acceptance(concurrent, inviteId, userId);
            }
            throw new PlatformControlPlaneError(
                "clerk_unavailable",
                "Could not join the organization. Please retry",
                503,
            );
        }
        const parsed = v.safeParse(membershipSchema, await this.json(response, signal));
        const receipt =
            parsed.success && parsed.output.public_user_data.user_id === userId
                ? acceptance(parsed.output, inviteId, userId)
                : null;
        if (receipt === null) {
            throw new PlatformControlPlaneError(
                "clerk_invalid_response",
                "Organization service returned an invalid membership",
                502,
            );
        }
        return receipt;
    };
}
