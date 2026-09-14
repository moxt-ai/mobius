import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    createBotApplication,
    createMobiusApplication,
    createWorkerContext,
    type LiteSessionConfigurationEnvironment,
    type PublicProjectBootstrapEnvironment,
    publicProjectBootstrapPolicyFromEnvironment,
    StaticSessionQuotaPolicyProvider,
    sessionQuotaFromEnvironment,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { D1ProjectAuthentication } from "./d1-project-authentication.ts";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay } from "./durable-objects.ts";
import { StandaloneProjectStorageDirectory } from "./project-storage-directory.ts";

export interface RelayBindings extends LiteSessionConfigurationEnvironment, PublicProjectBootstrapEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}
const application = createMobiusApplication();
const botApplication = createBotApplication();

export interface StandaloneWorker {
    readonly fetch: (request: Request, environment: RelayBindings) => Promise<Response>;
}

function withoutTenantFields(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(withoutTenantFields);
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const projected: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
        if (key !== "tenantId") {
            projected[key] = withoutTenantFields(field);
        }
    }
    return projected;
}

async function accountlessResponse(response: Response): Promise<Response> {
    if (!response.headers.get("content-type")?.includes("application/json")) {
        return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(withoutTenantFields(await response.json())), {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}

function isVersionedSharedProjectPath(pathname: string): boolean {
    return (
        /^\/mobius\/api\/v1\/projects\/[^/]+\/(?:browser-credentials|runtime-pairings|runtimes|session-imports|sessions)(?:\/|$)/.test(
            pathname,
        ) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/runtime-pairings/`) ||
        pathname === `${MOBIUS_API_PREFIX}/v1/runtimes/connect`
    );
}

export function createStandaloneApplication(
    gateways: (environment: RelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: RelayBindings }> {
    return new Hono<{ Bindings: RelayBindings }>().all("*", async (context) => {
        const request = context.req.raw;
        const environment = context.env;
        const pathname = new URL(request.url).pathname;
        const projectAuthentication = new D1ProjectAuthentication(
            environment.DIRECTORY_DATABASE,
            environment.MOBIUS_TENANT_ID,
        );
        const cx = createWorkerContext({
            gateways: gateways(environment),
            authorization: projectAuthentication,
            bootstrap: publicProjectBootstrapPolicyFromEnvironment(environment.DIRECTORY_DATABASE, environment),
            databases: new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
            identityDatabases: [environment.DIRECTORY_DATABASE],
            projects: new StandaloneProjectStorageDirectory(),
            apiPrefix: MOBIUS_API_PREFIX,
            quotaPolicy: new StaticSessionQuotaPolicyProvider(sessionQuotaFromEnvironment(environment)),
        });
        if (isVersionedSharedProjectPath(pathname)) {
            return await accountlessResponse(await application.fetch(request, cx));
        }
        if (pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`) && cx.services.bots !== null) {
            return await accountlessResponse(
                await botApplication.fetch(request, {
                    services: { bots: cx.services.bots },
                }),
            );
        }
        return await accountlessResponse(await application.fetch(request, cx));
    });
}

export function createStandaloneWorker(): StandaloneWorker {
    const app = createStandaloneApplication(createStandaloneGateways);
    return { fetch: async (request, environment) => await app.fetch(request, environment) };
}

export function createStandaloneGateways(environment: RelayBindings): WorkerRuntimeGateways {
    return {
        channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
        sessions: new CloudflareSessionTransport(environment.SESSION_RELAY, environment.MOBIUS_TENANT_ID),
        connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
    };
}

const worker: ExportedHandler<RelayBindings> = createStandaloneWorker();

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
