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
import { directLiveSessionEventReceiverFactory, subscribeToLiveEvents } from "./standalone-live-event-subscription.ts";
import { StandaloneProjectAuthentication } from "./standalone-project-authentication.ts";
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
    const standalone: StandaloneWorker = {
        fetch: async (request, environment) => {
            if (/\/v1\/projects\/[^/]+\/sessions(?:\/|$)/u.test(new URL(request.url).pathname)) {
                return Response.json(
                    { error: { code: "session_unavailable", message: "Cloud Sessions are unavailable." } },
                    { status: 410 },
                );
            }
            if (new URL(request.url).pathname === `${MOBIUS_API_PREFIX}/v1/transport`) {
                const dispatch = async (forwarded: Request): Promise<Response> =>
                    await standalone.fetch(forwarded, environment);
                return acceptWebSocketHttpTransport(
                    request,
                    dispatch,
                    async (subscription, receive, signal) =>
                        await subscribeToLiveEvents(
                            subscription,
                            receive,
                            signal,
                            dispatch,
                            environment,
                            directLiveSessionEventReceiverFactory,
                        ),
                );
            }
            const metrics = new RequestAccessMetrics();
            const database = instrumentD1Database(environment.DIRECTORY_DATABASE, metrics);
            const context = createWorkerContext({
                authorization: new StandaloneProjectAuthentication(environment.MOBIUS_STANDALONE_TOKEN),
                databases: new StandaloneDatabaseResolver(database),
                identityDatabases: [D1DatabaseAdapter.from(database)],
                projects: new StandaloneProjectStorageDirectory(),
                apiPrefix: MOBIUS_API_PREFIX,
                gateways: {
                    channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
                },
            });
            return metrics.appendServerTiming(await application.fetch(request, context));
        },
    };
    return standalone;
}

const worker: ExportedHandler<StandaloneRelayBindings> = createStandaloneWorker();

export { RuntimeRelay };
export default worker;
