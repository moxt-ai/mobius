import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestMobiusPlatformBindings } from "../../../tests/infra/cloudflare.ts";
import { TestDeveloperAuthenticator } from "../../../tests/infra/identity.ts";
import { TestClerkOrganizations } from "../../../tests/infra/organizations.ts";
import { serveTestApp } from "../../../tests/infra/server.ts";
import { OrganizationInviteDialog } from "../../platform-app/src/components/organization-invite-dialog.tsx";
import { createPlatformClient } from "../../platform-app/src/services/platform-client.ts";
import { JoinOrganizationView } from "../../platform-app/src/views/join-organization-view.tsx";
import { PlatformApp } from "../../platform-app/src/views/platform-app-view.tsx";
import {
    createPlatformApplication,
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
} from "../../relay-cloudflare-platform/src/worker.ts";
import { waitForDocumentState } from "./app-integration-harness.ts";

let bindings: Awaited<ReturnType<typeof createTestMobiusPlatformBindings>> | undefined;

beforeAll(async () => {
    bindings = await createTestMobiusPlatformBindings();
});

afterAll(async () => {
    await bindings?.[Symbol.asyncDispose]();
});

it("Given an organization admin, When they share an invite link and a new user accepts it, Then the new user opens the organization's Platform dashboard", async ({
    signal,
}) => {
    if (bindings === undefined) {
        throw new Error("The Platform test bindings are not ready");
    }
    const env = bindings.env;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const controller = new AbortController();
    const cancellation = AbortSignal.any([signal, controller.signal]);
    const rendered = async (text: string) =>
        await waitForDocumentState(() => document.body.textContent?.includes(text) === true, cancellation);
    const click = (text: string) => {
        const button = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent === text);
        if (button === undefined) {
            throw new Error(`Missing button: ${text}`);
        }
        flushSync(() => button.click());
    };
    try {
        const identity = new TestDeveloperAuthenticator();
        const clerk = new TestClerkOrganizations();
        const app = createPlatformApplication(
            new PlatformAuthenticationConfiguration(identity, new Set(), new Set(["*"])),
            createPlatformGateways,
            () => clerk,
        );
        await using server = await serveTestApp({
            app: { request: (request) => app.fetch(request, env) },
            signal: cancellation,
            onServerMessage: () => {},
        });
        try {
            const admin = identity.session("user_admin", "org_invites");
            const visitor = identity.session("user_visitor", "");
            const organization = { id: "org_invites", name: "Invite team" };
            const adminToken = async () => admin;
            const visitorToken = async () => visitor;
            flushSync(() =>
                root.render(
                    <PlatformApp
                        endpoint={server.origin}
                        getToken={adminToken}
                        organization={organization}
                        userControl={null}
                        organizationControl={
                            <OrganizationInviteDialog
                                endpoint={server.origin}
                                getToken={adminToken}
                                organization={organization}
                            />
                        }
                    />,
                ),
            );
            click("Invite members");
            await rendered("No active invite links.");
            click("Create invite link");
            await rendered("Your invite link");
            const input = document.querySelector("#organization-invite-link");
            if (!(input instanceof HTMLInputElement)) {
                throw new Error("Invite link was not displayed");
            }
            const token = new URL(input.value).hash.slice(1);
            expect(token).toMatch(/^[a-f0-9]{64}$/);
            flushSync(() =>
                root.render(
                    <JoinOrganizationView
                        endpoint={server.origin}
                        getToken={visitorToken}
                        token={token}
                        onJoined={async (id, signal) => {
                            const role = await clerk.role(id, "user_visitor", signal);
                            expect(role).toBe("org:member");
                            if (role === null) {
                                throw new Error("Membership was not created");
                            }
                            const session = identity.session("user_visitor", id, role);
                            root.render(
                                <PlatformApp
                                    key={session}
                                    endpoint={server.origin}
                                    getToken={async () => session}
                                    organization={organization}
                                    userControl={null}
                                    organizationControl={null}
                                />,
                            );
                        }}
                    />,
                ),
            );
            await rendered("Join Invite team");
            await createPlatformClient(server.origin, adminToken).createApp(
                "org_invites",
                "Shared application",
                cancellation,
            );
            click("Join organization");
            await rendered("Shared application");
            await rendered("Active");
            expect(container.textContent).toContain("Invite team");
            expect(container.textContent).toContain("org_invites");
            expect(container.textContent).not.toContain("Could not join");
        } finally {
            flushSync(() => root.unmount());
        }
    } finally {
        controller.abort();
        container.remove();
        vi.useRealTimers();
    }
});
