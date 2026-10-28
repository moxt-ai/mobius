import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeClerk } from "../../test-support/src/clerk.ts";
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
    const clerk = new FakeClerk();
    clerk.createOrganization("org_invites", "Invite team");
    clerk.setMembership("org_invites", "user_admin", "org:admin");
    const identity = clerk.authenticator;
    const application = createPlatformApplication(
        new PlatformAuthenticationConfiguration(identity, new Set()),
        createPlatformGateways,
        () => clerk.organizationGateway,
    );
    const admin = clerk.session("user_admin", "org_invites");
    const visitor = clerk.session("user_visitor", "");
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
    const audits = async (id: string, action: string) => {
        const response = await request("tenants/org_invites/audit-events", admin);
        expect(response.status).toBe(200);
        const { events } = await response.json<{
            events: readonly {
                readonly action: string;
                readonly subjectId: string;
                readonly actorId: string;
                readonly outcome: string;
            }[];
        }>();
        return events.filter((event) => event.action === action && event.subjectId === id);
    };
    return {
        request,
        admin,
        visitor,
        clerk,
        revocations: (id: string) => audits(id, "organization_invite.revoked"),
        acceptances: (id: string) => audits(id, "organization_invite.accepted"),
    };
}

it("Given an admin's shareable link, When a user without an organization previews and accepts it twice, Then they join as a member with exactly one acceptance audit", async () => {
    const { request, admin, visitor, clerk, acceptances } = fixture();
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
        expect(await accepted.json()).toEqual({
            organizationId: "org_invites",
            organizationName: "Invite team",
            member: true,
        });
        expect(await acceptances(link.id)).toMatchObject([{ actorId: "user_visitor", outcome: "succeeded" }]);
    }
    await expect(
        clerk.organizationGateway.role("org_invites", "user_visitor", new AbortController().signal),
    ).resolves.toBe("org:member");
    const listed = await (await request("tenants/org_invites/invite-links", admin)).text();
    expect(listed).toContain(link.id);
    expect(listed).not.toContain(link.token);
});

it("Given an existing organization admin, When they accept a shared invite, Then their role is preserved without an acceptance audit", async () => {
    const { request, admin, clerk, acceptances } = fixture();
    const link = await (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{
        token: string;
        id: string;
    }>();
    const accepted = await request("invite-links/accept", admin, "POST", { token: link.token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
        organizationId: "org_invites",
        organizationName: "Invite team",
        member: true,
    });
    expect(clerk.membership("org_invites", "user_admin")).toBe("org:admin");
    expect(await acceptances(link.id)).toEqual([]);
});

it("Given a shared link, When it is revoked or expires, Then recipients cannot join", async () => {
    const { request, admin, visitor, clerk } = fixture();
    const create = async () =>
        (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{ token: string; id: string }>();
    const revoked = await create();
    expect((await request(`tenants/org_invites/invite-links/${revoked.id}`, admin, "DELETE")).status).toBe(200);
    expect((await request("invite-links/accept", visitor, "POST", { token: revoked.token })).status).toBe(410);
    const expired = await create();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    expect(
        (await request("invite-links/accept", clerk.session("user_visitor"), "POST", { token: expired.token })).status,
    ).toBe(410);
});

it("Given a non-admin or an admin whose role was removed in Clerk, When they manage invite links, Then access is denied", async () => {
    const { request, admin, visitor, clerk } = fixture();
    expect((await request("tenants/org_invites/invite-links", visitor, "POST", {})).status).toBe(403);
    clerk.setMembership("org_invites", "user_admin", "org:member");
    expect((await request("tenants/org_invites/invite-links", admin, "POST", {})).status).toBe(403);
    expect((await request("tenants/org_other/invite-links", admin)).status).toBe(403);
});

it("Given a revoked invite, When an admin retries revocation, Then only the first request reports a change and creates a success audit", async () => {
    const { request, admin, revocations } = fixture();
    const link = await (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{ id: string }>();
    const revoke = () => request(`tenants/org_invites/invite-links/${link.id}`, admin, "DELETE");
    const first = await revoke();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });
    const audits = await revocations(link.id);
    expect(audits).toMatchObject([{ actorId: "user_admin", outcome: "succeeded" }]);

    const retry = await revoke();
    expect(retry.status).toBe(200);
    expect.soft(await retry.json()).toEqual({ revoked: false });
    expect(await revocations(link.id)).toEqual(audits);
});

it("Given an unknown or another organization's invite, When an admin revokes it in their own organization, Then no revocation or success audit is reported", async () => {
    const { request, admin, visitor, clerk, revocations } = fixture();
    clerk.createOrganization("org_other", "Other team");
    clerk.setMembership("org_other", "user_other", "org:admin");
    const otherAdmin = clerk.session("user_other", "org_other");
    const link = await (await request("tenants/org_other/invite-links", otherAdmin, "POST", {})).json<{
        id: string;
        token: string;
    }>();
    for (const id of [crypto.randomUUID(), link.id]) {
        const response = await request(`tenants/org_invites/invite-links/${id}`, admin, "DELETE");
        expect(response.status).toBe(200);
        expect.soft(await response.json()).toEqual({ revoked: false });
        expect.soft(await revocations(id)).toEqual([]);
    }
    expect((await request("invite-links/preview", visitor, "POST", { token: link.token })).status).toBe(200);
});

it("Given an active invite, When two admins revoke it concurrently, Then exactly one reports a change and is recorded as the revoker", async () => {
    const { request, admin, visitor, clerk, revocations } = fixture();
    clerk.setMembership("org_invites", "user_second", "org:admin");
    const secondAdmin = clerk.session("user_second", "org_invites");
    const link = await (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{
        id: string;
        token: string;
    }>();
    const results = await Promise.all(
        [
            { token: admin, actorId: "user_admin" },
            { token: secondAdmin, actorId: "user_second" },
        ].map(async ({ token, actorId }) => {
            const response = await request(`tenants/org_invites/invite-links/${link.id}`, token, "DELETE");
            expect(response.status).toBe(200);
            const result = await response.json<{ revoked: boolean }>();
            return { ...result, actorId };
        }),
    );
    expect.soft(results.map((result) => result.revoked).sort()).toEqual([false, true]);
    const winner = results.find((result) => result.revoked);
    expect(await revocations(link.id)).toMatchObject([{ actorId: winner?.actorId, outcome: "succeeded" }]);
    expect((await request("invite-links/preview", visitor, "POST", { token: link.token })).status).toBe(410);
});

it("Given an active invite, When its revocation audit cannot be stored, Then revocation rolls back and can be retried", async () => {
    const { request, admin, visitor, revocations } = fixture();
    const link = await (await request("tenants/org_invites/invite-links", admin, "POST", {})).json<{
        id: string;
        token: string;
    }>();
    await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `CREATE TRIGGER reject_invite_revocation_audit BEFORE INSERT ON platform_dashboard_audit_events
         WHEN NEW.action = 'organization_invite.revoked'
         BEGIN SELECT RAISE(ABORT, 'Controlled revocation failure'); END`,
    ).run();
    try {
        const response = await request(`tenants/org_invites/invite-links/${link.id}`, admin, "DELETE");
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
        expect(await revocations(link.id)).toEqual([]);
        expect((await request("invite-links/preview", visitor, "POST", { token: link.token })).status).toBe(200);
    } finally {
        await env.PLATFORM_DIRECTORY_DATABASE.prepare("DROP TRIGGER reject_invite_revocation_audit").run();
    }
    const retry = await request(`tenants/org_invites/invite-links/${link.id}`, admin, "DELETE");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ revoked: true });
    expect(await revocations(link.id)).toMatchObject([{ actorId: "user_admin", outcome: "succeeded" }]);
    expect((await request("invite-links/preview", visitor, "POST", { token: link.token })).status).toBe(410);
});
