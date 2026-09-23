import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { createPlatformGateways, createTestMobiusPlatformApp } from "./app.ts";
import { FakeClerk } from "./clerk.ts";
import { createTestMobiusPlatformBindings, WebSocketPair, WorkerResponse } from "./cloudflare.ts";
import { createFakeAgentDaemonRuntime } from "./platform-agent-daemon.ts";
import { serveTestApp } from "./server.ts";

/** Starts the production Platform boundary with isolated local Cloudflare storage. */
export async function startTestPlatform(options: { readonly allowedOrigins?: ReadonlySet<string> } = {}) {
    const cancellation = new AbortController();
    const runtimes: Awaited<ReturnType<typeof createFakeAgentDaemonRuntime>>[] = [];
    const previousResponse = globalThis.Response;
    const previousWebSocketPair = Reflect.get(globalThis, "WebSocketPair");
    globalThis.Response = WorkerResponse as unknown as typeof Response;
    Reflect.set(globalThis, "WebSocketPair", WebSocketPair);

    const bindings = await createTestMobiusPlatformBindings();
    let server: Awaited<ReturnType<typeof serveTestApp>> | undefined;
    try {
        const clerk = new FakeClerk();
        const app = createTestMobiusPlatformApp(
            {
                bindings: bindings.env,
                developerAuthenticator: clerk.authenticator,
                operatorSubjects: new Set(["developer-1"]),
                allowedOrigins: new Set(options.allowedOrigins),
            },
            createPlatformGateways,
        );
        const developerToken = clerk.session("developer-1", clerk.defaultOrganizationId);
        const developer = new MobiusPlatformDeveloperClient({
            endpoint: "http://platform.test",
            authenticationProviderId: "clerk",
            credentialProvider: new MobiusOidcCredentialProvider(developerToken),
            transport: { fetch: async (request) => await app.request(request) },
        });
        const tenant = (await developer.listTenants(cancellation.signal))[0];
        if (tenant === undefined) {
            throw new Error("Missing test organization");
        }
        const application = await developer.createApp(tenant.tenantId, "Test application", cancellation.signal);
        const credential = application.defaultCredential?.credential;
        if (credential === undefined) {
            throw new Error("Missing default test application credential");
        }
        const runningServer = await serveTestApp({
            app,
            signal: cancellation.signal,
            onServerMessage: () => undefined,
        });
        server = runningServer;

        const close = async (): Promise<void> => {
            try {
                await Promise.all(runtimes.splice(0).map(async (runtime) => runtime[Symbol.asyncDispose]()));
            } finally {
                cancellation.abort(new Error("Test Platform stopped"));
                try {
                    await runningServer[Symbol.asyncDispose]();
                } finally {
                    if (previousWebSocketPair === undefined) {
                        Reflect.deleteProperty(globalThis, "WebSocketPair");
                    } else {
                        Reflect.set(globalThis, "WebSocketPair", previousWebSocketPair);
                    }
                    globalThis.Response = previousResponse;
                    await bindings[Symbol.asyncDispose]();
                }
            }
        };

        return {
            app,
            appId: application.appId,
            appCredential: credential,
            attachments: bindings.env.R2_BUCKET_APAC,
            baseUrl: runningServer.origin,
            developer,
            developerToken,
            connectAgent: async (projectId: string) => {
                const runtime = await createFakeAgentDaemonRuntime({
                    credential,
                    origin: runningServer.origin,
                    projectId,
                    server: app,
                    signal: cancellation.signal,
                });
                runtimes.push(runtime);
                return runtime;
            },
            close,
            [Symbol.asyncDispose]: close,
        };
    } catch (cause) {
        cancellation.abort(cause);
        await server?.[Symbol.asyncDispose]();
        if (previousWebSocketPair === undefined) {
            Reflect.deleteProperty(globalThis, "WebSocketPair");
        } else {
            Reflect.set(globalThis, "WebSocketPair", previousWebSocketPair);
        }
        globalThis.Response = previousResponse;
        await bindings[Symbol.asyncDispose]();
        throw cause;
    }
}
