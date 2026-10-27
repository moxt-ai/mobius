// @vitest-environment happy-dom
import { createServer, request } from "node:http";
import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { DetachedWindowAPI } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { createTestMobiusPlatformBindings } from "../../test-support/src/cloudflare.ts";
import { listen, port } from "../../test-support/src/websocket.ts";
import { PlatformApp } from "../src/application.tsx";

const observers = new Set<MutationObserver>();

function visibleElement(selector: string): Promise<Element> {
    const existing = document.querySelector(selector);
    if (existing !== null) {
        return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element !== null) {
                observer.disconnect();
                observers.delete(observer);
                resolve(element);
            }
        });
        observers.add(observer);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
}

function button(name: string): HTMLButtonElement {
    const result = [...document.querySelectorAll("button")].find(
        (element) => (element.getAttribute("aria-label") ?? element.textContent.trim()) === name,
    );
    if (result === undefined) {
        throw new Error(`Button not found: ${name}`);
    }
    return result;
}

/** Forward real HTTP requests and lose the next credential-list response after it completes upstream. */
async function credentialListLossProxy(upstream: string) {
    let loseNextList = false;
    const listWaiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const issuedSecret = Promise.withResolvers<string>();
    const server = createServer((incoming, outgoing) => {
        const credentials = incoming.url?.endsWith("/credentials") === true;
        const loseResponse = credentials && incoming.method === "GET" && loseNextList;
        if (loseResponse) {
            loseNextList = false;
        }
        const forwarded = request(
            new URL(incoming.url ?? "/", upstream),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host, "accept-encoding": "identity" },
            },
            (response) => {
                if (loseResponse) {
                    response.resume();
                    response.on("end", () => {
                        listWaiting.resolve();
                        void release.promise.then(() => outgoing.destroy());
                    });
                    return;
                }
                if (credentials && incoming.method === "POST") {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () => {
                        const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
                        if (
                            typeof value === "object" &&
                            value !== null &&
                            "credential" in value &&
                            typeof value.credential === "string"
                        ) {
                            issuedSecret.resolve(value.credential);
                        } else {
                            issuedSecret.reject(new Error("No issued credential in the service response"));
                        }
                    });
                }
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.on("aborted", () => forwarded.destroy());
        incoming.pipe(forwarded);
    });
    await listen(server);
    return {
        endpoint: `http://127.0.0.1:${port(server)}`,
        issuedSecret: issuedSecret.promise,
        listWaiting: listWaiting.promise,
        loseNextList: () => {
            loseNextList = true;
        },
        release: () => release.resolve(),
        [Symbol.asyncDispose]: async () => {
            release.resolve();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

afterEach(() => {
    for (const observer of observers) {
        observer.disconnect();
    }
    observers.clear();
    document.body.replaceChildren();
    vi.useRealTimers();
});

test("Given a successful key issuance, when the following list refresh fails, the user can still reveal and copy that one key", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z"), toFake: ["Date"] });
    await using platform = await createTestMobiusPlatformBindings(new Set([window.location.origin]));
    await using proxy = await credentialListLossProxy(platform.origin);
    if (!("happyDOM" in window) || !(window.happyDOM instanceof DetachedWindowAPI)) {
        throw new Error("Expected the browser test environment");
    }
    window.happyDOM.setURL(proxy.endpoint);
    const signal = AbortSignal.timeout(10_000);
    const token = "local-platform-developer";
    const developer = new MobiusPlatformDeveloperClient({
        endpoint: platform.origin,
        authenticationProviderId: "clerk",
        credentialProvider: new MobiusOidcCredentialProvider(token),
        transport: { fetch: platform.request },
    });
    const tenant = (await developer.listTenants(signal))[0];
    if (tenant === undefined) {
        throw new Error("No test organization");
    }
    const app = await developer.createApp(tenant.tenantId, "Credential recovery", signal);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => {
            root.render(
                createElement(PlatformApp, {
                    endpoint: proxy.endpoint,
                    getToken: async () => token,
                    organization: { id: tenant.tenantId, name: tenant.displayName },
                    organizationControl: null,
                    userControl: null,
                }),
            );
        });
        await visibleElement('button[aria-label="Revoke key 1"]');
        proxy.loseNextList();
        await act(async () => {
            button("Create key").click();
            await proxy.listWaiting;
        });
        expect
            .soft(document.querySelector('[role="dialog"]'), "Show the secret before the refresh finishes")
            .not.toBeNull();
        proxy.release();
        await visibleElement('[role="alert"]');
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Save your app secret");
        await act(async () => button("Show secret").click());
        const secret = await proxy.issuedSecret;
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(secret);
        await act(async () => button("Copy App secret").click());
        expect(await navigator.clipboard.readText()).toBe(secret);
        await act(async () => button("I’ve saved the secret").click());
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
            "The key was created, but the key list could not be refreshed.",
        );
        expect(await developer.listAppCredentials(app.appId, signal)).toHaveLength(2);
    } finally {
        proxy.release();
        await act(async () => root.unmount());
    }
});
