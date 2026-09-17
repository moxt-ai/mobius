import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TestDeveloperAuthenticator } from "../../../tests/infra/identity.ts";
import { TestClerkOrganizations } from "../../../tests/infra/organizations.ts";
import {
    createPlatformApplication,
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
} from "../src/worker.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function fixture() {
    const identity = new TestDeveloperAuthenticator();
    const clerk = new TestClerkOrganizations();
    const application = createPlatformApplication(
        new PlatformAuthenticationConfiguration(identity, new Set()),
        createPlatformGateways,
        () => clerk,
    );
    const admin = identity.session("user_admin", "org_invites");
    const visitor = identity.session("user_visitor", "");
    const request = (path: string, token: string, method = "GET", body?: unknown) =>
        application.fetch(
            new Request(`https://platform.test/mobius/api/dashboard/v1/platform/${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-mobius-oidc-provider": "clerk",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            env,
        );
    return { request, admin, visitor, clerk };
}

it("Given an admin's shareable link, When a user without an organization previews and accepts it twice, Then they join as a member and can open the organization", async () => {
    const { request, admin, visitor, clerk } = fixture();
    const created = await request("tenants/org_invites/invite-links", admin, "POST", {});
    expect(created.status).toBe(201);
    const link = await created.json<{ token: string; id: string }>();
    expect(await (await request("invite-links/preview", visitor, "POST", { token: link.token })).json()).toMatchObject({
        organizationId: "org_invites",
        organizationName: "Invite team",
        member: false,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const accepted = await request("invite-links/accept", visitor, "POST", { token: link.token });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toMatchObject({ organizationId: "org_invites" });
    }
    expect(clerk.members.get("user_visitor")).toBe("org:member");
    const listed = await (await request("tenants/org_invites/invite-links", admin)).text();
    expect(listed).toContain(link.id);
    expect(listed).not.toContain(link.token);
});

it("Given a shared link, When it is revoked or expires, Then recipients cannot join", async () => {
    const { request, admin, visitor } = fixture();
    const create = async () =>
        (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{ token: string; id: string }>();
    const revoked = await create();
    expect((await request(`tenants/org_invites/invite-links/${revoked.id}`, admin, "DELETE")).status).toBe(200);
    expect((await request("invite-links/accept", visitor, "POST", { token: revoked.token })).status).toBe(410);
    const expired = await create();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    expect((await request("invite-links/accept", visitor, "POST", { token: expired.token })).status).toBe(410);
});

it("Given a non-admin or an admin whose role was removed in Clerk, When they manage invite links, Then access is denied", async () => {
    const { request, admin, visitor, clerk } = fixture();
    expect((await request("tenants/org_invites/invite-links", visitor, "POST", {})).status).toBe(403);
    clerk.members.set("user_admin", "org:member");
    expect((await request("tenants/org_invites/invite-links", admin, "POST", {})).status).toBe(403);
    expect((await request("tenants/org_other/invite-links", admin)).status).toBe(403);
});
