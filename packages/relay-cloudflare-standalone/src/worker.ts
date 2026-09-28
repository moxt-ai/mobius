import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    acceptWebSocketHttpTransport,
    CloudflareChannelRuntime,
    createMobiusApplication,
    createWorkerContext,
    D1DatabaseAdapter,
    instrumentD1Database,
    RequestAccessMetrics,
} from "@moxt-ai/mobius-relay-core";
import { StandaloneDatabaseResolver } from "./standalone-database-resolver.ts";
import { RuntimeRelay } from "./standalone-durable-objects.ts";
import { StandaloneProjectAuthentication } from "./standalone-project-authentication.ts";
import { StandaloneProjectAuthenticationStorage } from "./standalone-project-authentication-storage.ts";
import { StandaloneProjectStorageDirectory } from "./standalone-project-storage-directory.ts";

export interface StandaloneRelayBindings {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly MOBIUS_STANDALONE_TOKEN: string;
    readonly RUNTIME_RELAY: DurableObjectNamespace<RuntimeRelay>;
}

export interface StandaloneWorker {
    readonly fetch: (request: Request, environment: StandaloneRelayBindings) => Promise<Response>;
}

const application = createMobiusApplication();

export function createStandaloneWorker(): StandaloneWorker {
    const standaloneWorker: StandaloneWorker = {
        fetch: async (request, environment) => {
            const requestUrl = new URL(request.url);
            if (requestUrl.pathname === `${MOBIUS_API_PREFIX}/v1/transport`) {
                const dispatch = async (forwarded: Request): Promise<Response> =>
                    await standaloneWorker.fetch(forwarded, environment);
                return acceptWebSocketHttpTransport(request, dispatch);
            }
            const metrics = new RequestAccessMetrics();
            const database = instrumentD1Database(environment.DIRECTORY_DATABASE, metrics);
            const authentication = new StandaloneProjectAuthentication(
                environment.MOBIUS_STANDALONE_TOKEN,
                new StandaloneProjectAuthenticationStorage(D1DatabaseAdapter.from(database)),
            );
            const context = createWorkerContext({
                applications: authentication,
                authorization: authentication,
                databases: new StandaloneDatabaseResolver(database),
                identityDatabases: [D1DatabaseAdapter.from(database)],
                projects: new StandaloneProjectStorageDirectory(),
                apiPrefix: MOBIUS_API_PREFIX,
                gateways: {
                    channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
                },
            });
            if (
                request.method === "POST" &&
                requestUrl.pathname === `${MOBIUS_API_PREFIX}/v1/standalone/browser-credentials`
            ) {
                const response = Response.json(
                    await context.services.runtimePairings.createBrowserCredential(
                        "standalone",
                        environment.MOBIUS_STANDALONE_TOKEN,
                        60 * 60 * 1_000,
                        request.signal,
                    ),
                    { status: 201 },
                );
                response.headers.set("Cache-Control", "no-store");
                return metrics.appendServerTiming(response);
            }
            return metrics.appendServerTiming(await application.fetch(request, context));
        },
    };
    return standaloneWorker;
}

const worker: ExportedHandler<StandaloneRelayBindings> = createStandaloneWorker();

export { RuntimeRelay };
export default worker;
