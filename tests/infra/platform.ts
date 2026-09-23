import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { FakeClerk } from "./clerk.ts";
import { createTestMobiusPlatformBindings } from "./cloudflare.ts";
import { createFakeAgentDaemonRuntime } from "./platform-agent-daemon.ts";

/** Starts the production Platform boundary with isolated local Cloudflare storage. */
export async function startTestPlatform(options: { readonly allowedOrigins?: ReadonlySet<string> } = {}) {
    const cancellation = new AbortController();
    const runtimes: Awaited<ReturnType<typeof createFakeAgentDaemonRuntime>>[] = [];
    const bindings = await createTestMobiusPlatformBindings(options.allowedOrigins);
    try {
        const clerk = new FakeClerk();
        const app = { request: bindings.request };
        const developerToken = clerk.session("developer-1", clerk.defaultOrganizationId);
        const developer = new MobiusPlatformDeveloperClient({
            endpoint: bindings.origin,
            authenticationProviderId: "clerk",
            credentialProvider: new MobiusOidcCredentialProvider(developerToken),
            transport: { fetch: bindings.request },
        });
        const tenant = (await developer.listTenants(cancellation.signal))[0];
        if (tenant === undefined) {
            throw new Error("Missing test tenant");
        }
        const application = await developer.createApp(tenant.tenantId, "Test application", cancellation.signal);
        const credential = application.defaultCredential?.credential;
        if (credential === undefined) {
            throw new Error("Missing default test application credential");
        }
        const close = async (): Promise<void> => {
            cancellation.abort(new Error("Test Platform stopped"));
            try {
                await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime[Symbol.asyncDispose]()));
            } finally {
                await bindings[Symbol.asyncDispose]();
            }
        };
        return {
            app,
            appId: application.appId,
            appCredential: credential,
            attachments: bindings.env.R2_BUCKET_APAC,
            baseUrl: bindings.origin,
            developer,
            developerToken,
            connectAgent: async (projectId: string) => {
                const runtime = await createFakeAgentDaemonRuntime({
                    credential,
                    origin: bindings.origin,
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
        await bindings[Symbol.asyncDispose]();
        throw cause;
    }
}
