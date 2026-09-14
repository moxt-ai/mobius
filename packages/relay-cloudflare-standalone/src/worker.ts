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
    type RelayContext,
    StaticSessionQuotaPolicyProvider,
    sessionQuotaFromEnvironment,
    type WorkerRuntimeGateways,
} from "@moxt-ai/mobius-relay-core";
import { type Handler, Hono } from "hono";
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

type DispatchEnvironment = { readonly Bindings: RelayContext };

const sharedProjectHandler: Handler<DispatchEnvironment> = (context) => application.fetch(context.req.raw, context.env);

const projectRoutes = new Hono<DispatchEnvironment>()
    .all("/browser-credentials/*", sharedProjectHandler)
    .all("/runtime-pairings/*", sharedProjectHandler)
    .all("/runtimes/*", sharedProjectHandler)
    .all("/session-imports/*", sharedProjectHandler)
    .all("/sessions/*", sharedProjectHandler);

const versionedRoutes = new Hono<DispatchEnvironment>()
    .route("/projects/:projectId", projectRoutes)
    .all("/runtime-pairings/*", sharedProjectHandler)
    .all("/runtimes/connect", sharedProjectHandler)
    .all("/*", (context) => {
        const bots = context.env.services.bots;
        return bots === null
            ? application.fetch(context.req.raw, context.env)
            : botApplication.fetch(context.req.raw, { services: { bots } });
    });

const dispatchApplication = new Hono<DispatchEnvironment>()
    .onError((error) => {
        throw error;
    })
    .route(MOBIUS_API_PREFIX, new Hono<DispatchEnvironment>().route("/v1", versionedRoutes))
    .all("*", sharedProjectHandler);

export function createStandaloneApplication(
    gateways: (environment: RelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: RelayBindings }> {
    return new Hono<{ Bindings: RelayBindings }>().all("*", async (context) => {
        const request = context.req.raw;
        const environment = context.env;
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
        return await accountlessResponse(await dispatchApplication.fetch(request, cx));
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
