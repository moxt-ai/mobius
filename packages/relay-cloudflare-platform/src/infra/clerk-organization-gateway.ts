import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { OrganizationMembershipGateway } from "./organization-membership-gateway.ts";

const organizationSchema = v.object({
    id: v.pipe(v.string(), v.regex(/^org_[a-zA-Z0-9]+$/)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
const membershipSchema = v.object({ role: v.string(), public_user_data: v.object({ user_id: v.string() }) });
const membershipsSchema = v.object({ data: v.array(membershipSchema) });

export class ClerkOrganizationGateway implements OrganizationMembershipGateway {
    private readonly secret: string | undefined;
    constructor(secret: string | undefined) {
        this.secret = secret;
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
            return await fetch(`https://api.clerk.com/v1/organizations/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
                redirect: "error",
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

    readonly role = async (id: string, userId: string, signal: AbortSignal): Promise<string | null> => {
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
        return parsed.output.data.find((entry) => entry.public_user_data.user_id === userId)?.role ?? null;
    };

    readonly join = async (id: string, userId: string, signal: AbortSignal): Promise<void> => {
        if ((await this.role(id, userId, signal)) !== null) {
            return;
        }
        const response = await this.request(`${encodeURIComponent(id)}/memberships`, signal, {
            user_id: userId,
            role: "org:member",
        });
        // A concurrent redemption may have already created the membership. Never change an existing role.
        if (!response.ok) {
            await response.body?.cancel();
            if ((await this.role(id, userId, signal)) !== null) {
                return;
            }
            throw new PlatformControlPlaneError(
                "clerk_unavailable",
                "Could not join the organization. Please retry",
                503,
            );
        }
        const parsed = v.safeParse(membershipSchema, await this.json(response, signal));
        if (!parsed.success || parsed.output.public_user_data.user_id !== userId) {
            throw new PlatformControlPlaneError(
                "clerk_invalid_response",
                "Organization service returned an invalid membership",
                502,
            );
        }
    };
}
