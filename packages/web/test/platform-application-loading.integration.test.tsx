import { createServer, type ServerResponse } from "node:http";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { platformDataTestId } from "../../platform-app/src/data-testid.ts";
import { createPlatformTestApplication } from "./platform-app-integration-harness.ts";

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
        cloudRetention: true,
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
    const endpoint = `http://127.0.0.1:${address.port}`;
    const application = createPlatformTestApplication({
        endpoint,
        getToken: async () => "developer",
        userControl: null,
        organization: { id: tenant.tenantId, name: tenant.displayName },
        organizationControl: null,
    });
    const { container } = application;
    const rendered = (text: string) =>
        new Promise<void>((resolve) => {
            if (container.textContent?.includes(text)) {
                resolve();
                return;
            }
            const observer = new MutationObserver(() => {
                if (container.textContent?.includes(text)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(container, { childList: true, subtree: true, characterData: true });
        });
    try {
        await requested.get("Alpha")?.promise;
        const alphaRendered = rendered("Active");
        release("Alpha", "");
        await alphaRendered;
        const beta = screen
            .getAllByTestId(platformDataTestId.applicationChoice)
            .find((entry) => entry.textContent?.startsWith("Beta"));
        if (beta === undefined) {
            throw new Error("Beta application is missing");
        }
        fireEvent.click(beta);
        await requested.get("Beta")?.promise;
        expect(container.textContent).toContain("Loading application");
        expect(container.textContent).not.toContain("Active");
        expect(screen.queryByTestId(platformDataTestId.revokeCredential)).toBeNull();
        const betaRendered = rendered("Revoked");
        release("Beta", timestamp);
        await betaRendered;
        expect(container.textContent).not.toContain("Loading application");
        expect(container.textContent).not.toContain("Active");
        const organizationRendered = rendered("No applications yet");
        application.rerender(
            {
                endpoint,
                getToken: async () => "other-organization",
                userControl: null,
                organization: { id: "org_other", name: "Other team" },
                organizationControl: null,
            },
            "org_other",
        );
        expect(screen.queryByTestId(platformDataTestId.revokeCredential)).toBeNull();
        await organizationRendered;
        expect(container.textContent).toContain("Other team");
        expect(container.textContent).toContain("org_other");
        expect(container.textContent).not.toContain("Alpha");
        expect(container.textContent).not.toContain("Beta");
    } finally {
        await application.destroy();
        for (const response of pending.values()) {
            response.end();
        }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        vi.useRealTimers();
    }
});

it("Given an application retains chat Session data in the cloud, When its owner disables cloud retention in Options, Then the saved setting is shown as disabled", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const update = Promise.withResolvers<Readonly<Record<string, unknown>>>();
    const app = {
        appId: "app_options",
        createdAt: timestamp,
        defaultCredentialId: "key-options",
        deletedAt: "",
        displayName: "Options app",
        lifecycle: "active",
        cloudRetention: true,
        suspendedAt: "",
        tenantId: "org_options",
        updatedAt: timestamp,
    };
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Headers", "*");
        if (request.method === "OPTIONS") {
            response.end();
        } else if (request.method === "GET" && request.url?.endsWith("/apps")) {
            response.end(JSON.stringify({ apps: [app] }));
        } else if (request.method === "GET" && request.url?.endsWith("/credentials")) {
            response.end(JSON.stringify({ credentials: [] }));
        } else if (request.method === "PUT" && request.url?.endsWith(`/apps/${app.appId}`)) {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (typeof body !== "object" || body === null || Array.isArray(body)) {
                    response.writeHead(400).end();
                    return;
                }
                update.resolve(Object.freeze(Object.fromEntries(Object.entries(body))));
                response.end(JSON.stringify({ ...app, cloudRetention: false }));
            });
        } else {
            response.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing server address");
    }
    const application = createPlatformTestApplication({
        endpoint: `http://127.0.0.1:${address.port}`,
        getToken: async () => "developer",
        userControl: null,
        organization: { id: app.tenantId, name: "Options team" },
        organizationControl: null,
    });
    const { container } = application;
    const rendered = (text: string) =>
        new Promise<void>((resolve) => {
            if (container.textContent?.includes(text)) {
                resolve();
                return;
            }
            const observer = new MutationObserver(() => {
                if (container.textContent?.includes(text)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(container, { childList: true, subtree: true, characterData: true });
        });
    try {
        const keysRendered = rendered("API keys");
        await keysRendered;
        const options = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Options",
        );
        if (options === undefined) {
            throw new Error("Options tab is missing");
        }
        fireEvent.mouseDown(options);
        const checkbox = container.querySelector<HTMLElement>(
            '[role="checkbox"][aria-label="Retain chat session data in Mobius Cloud"]',
        );
        if (checkbox === null) {
            throw new Error("Cloud retention checkbox is missing");
        }
        expect(checkbox?.getAttribute("aria-checked")).toBe("true");
        const saved = rendered("Application options saved.");
        fireEvent.click(checkbox);
        expect(await update.promise).toEqual({ displayName: app.displayName, cloudRetention: false });
        await saved;
        expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    } finally {
        await application.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});
