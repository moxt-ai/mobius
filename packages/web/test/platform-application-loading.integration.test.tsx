import { createServer, type ServerResponse } from "node:http";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PlatformApp } from "../../platform-app/src/views/platform-app-view.tsx";

// A stateful Platform HTTP peer keeps credential reads pending until released,
// avoiding hosted Clerk credentials and nondeterministic network throttling.
it("Given an organization's application keys are visible, When a user switches applications and then organizations, Then only the selected tenant's applications and keys are displayed", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(timestamp));
    const lifecycle = {
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: "",
        suspendedAt: "",
        lifecycle: "active",
    };
    const tenant = { ...lifecycle, tenantId: "org_team", displayName: "Team", quotas: {} };
    const apps = ["Alpha", "Beta"].map((displayName) => ({
        ...lifecycle,
        appId: displayName,
        tenantId: tenant.tenantId,
        displayName,
        defaultCredentialId: `key-${displayName}`,
    }));
    const pending = new Map<string, ServerResponse>();
    const requested = new Map(apps.map((app) => [app.appId, Promise.withResolvers<void>()]));
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Headers", "*");
        if (request.method === "OPTIONS") {
            response.end();
        } else if (request.url?.endsWith("/tenants")) {
            response.end(JSON.stringify({ tenants: [tenant] }));
        } else if (request.url?.endsWith("/apps")) {
            response.end(JSON.stringify({ apps: request.url.includes("/org_team/") ? apps : [] }));
        } else {
            const app = apps.find((entry) => request.url?.endsWith(`/apps/${entry.appId}/credentials`));
            if (app === undefined) {
                response.writeHead(404).end();
                return;
            }
            pending.set(app.appId, response);
            requested.get(app.appId)?.resolve();
        }
    });
    const release = (appId: string, revokedAt: string) => {
        pending.get(appId)?.end(
            JSON.stringify({
                credentials: [
                    {
                        appId,
                        credentialId: `key-${appId}`,
                        allProjects: true,
                        issuedAt: timestamp,
                        lastUsedAt: "",
                        overlapEndsAt: "",
                        permissions: [],
                        projectIds: [],
                        publicCredentialId: appId,
                        replacedByCredentialId: "",
                        revision: 1,
                        revokedAt,
                    },
                ],
            }),
        );
        pending.delete(appId);
    };
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing server address");
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const rendered = (text: string) =>
        new Promise<void>((resolve) => {
            const observer = new MutationObserver(() => {
                if (container.textContent?.includes(text)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(container, { childList: true, subtree: true, characterData: true });
        });
    try {
        flushSync(() =>
            root.render(
                <PlatformApp
                    key={tenant.tenantId}
                    endpoint={`http://127.0.0.1:${address.port}`}
                    getToken={async () => "developer"}
                    userControl={null}
                    organization={{ id: tenant.tenantId, name: tenant.displayName }}
                    organizationControl={null}
                />,
            ),
        );
        await requested.get("Alpha")?.promise;
        const alphaRendered = rendered("Active");
        release("Alpha", "");
        await alphaRendered;
        const beta = Array.from(container.querySelectorAll("button")).find((button) =>
            button.textContent?.startsWith("Beta"),
        );
        if (beta === undefined) {
            throw new Error("Beta application is missing");
        }
        flushSync(() => beta.click());
        await requested.get("Beta")?.promise;
        expect(container.textContent).toContain("Loading application");
        expect(container.textContent).not.toContain("Active");
        expect(container.querySelector('[aria-label="Revoke key 1"]')).toBeNull();
        const betaRendered = rendered("Revoked");
        release("Beta", timestamp);
        await betaRendered;
        expect(container.textContent).not.toContain("Loading application");
        expect(container.textContent).not.toContain("Active");
        const organizationRendered = rendered("No applications yet");
        flushSync(() =>
            root.render(
                <PlatformApp
                    key="org_other"
                    endpoint={`http://127.0.0.1:${address.port}`}
                    getToken={async () => "other-organization"}
                    userControl={null}
                    organization={{ id: "org_other", name: "Other team" }}
                    organizationControl={null}
                />,
            ),
        );
        expect(container.querySelector('[aria-label="Revoke key 1"]')).toBeNull();
        await organizationRendered;
        expect(container.textContent).toContain("Other team");
        expect(container.textContent).toContain("org_other");
        expect(container.textContent).not.toContain("Alpha");
        expect(container.textContent).not.toContain("Beta");
        expect(container.querySelector('[aria-label="Create tenant"]')).toBeNull();
    } finally {
        flushSync(() => root.unmount());
        container.remove();
        for (const response of pending.values()) {
            response.end();
        }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        vi.useRealTimers();
    }
});
