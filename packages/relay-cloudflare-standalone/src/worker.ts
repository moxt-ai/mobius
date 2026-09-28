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
            const requestUrl = new URL(request.url);
            const pairingPrefix = `${MOBIUS_API_PREFIX}/pairings`;
            if (requestUrl.pathname === pairingPrefix || requestUrl.pathname.startsWith(`${pairingPrefix}/`)) {
                const pairingId = requestUrl.pathname.slice(`${pairingPrefix}/`.length);
                const target =
                    request.method === "POST"
                        ? `${MOBIUS_API_PREFIX}/v1/projects/standalone/runtime-pairings`
                        : `${MOBIUS_API_PREFIX}/v1/projects/standalone/runtime-pairings/${encodeURIComponent(pairingId)}`;
                const forwarded = new Request(
                    new URL(target, request.url),
                    request.method === "POST"
                        ? {
                              body: JSON.stringify({ idempotencyKey: `browser-${crypto.randomUUID()}` }),
                              headers: {
                                  authorization: `Bearer ${environment.MOBIUS_STANDALONE_TOKEN}`,
                                  "content-type": "application/json",
                              },
                              method: request.method,
                          }
                        : {
                              headers: { authorization: `Bearer ${environment.MOBIUS_STANDALONE_TOKEN}` },
                              method: request.method,
                          },
                );
                const response = await standalone.fetch(forwarded, environment);
                if (!response.ok || request.method !== "POST") {
                    return response;
                }
                const pairing: unknown = await response.json();
                if (typeof pairing !== "object" || pairing === null) {
                    return new Response("The standalone pairing response is invalid", { status: 502 });
                }
                return Response.json(
                    { ...pairing, hostToken: environment.MOBIUS_STANDALONE_TOKEN },
                    {
                        status: response.status,
                        headers: { "server-timing": response.headers.get("server-timing") ?? "" },
                    },
                );
            }
            if (new URL(request.url).pathname === `${MOBIUS_API_PREFIX}/v1/transport`) {
                const dispatch = async (forwarded: Request): Promise<Response> =>
                    await standalone.fetch(forwarded, environment);
                return acceptWebSocketHttpTransport(request, dispatch);
            }
            const metrics = new RequestAccessMetrics();
            const database = instrumentD1Database(environment.DIRECTORY_DATABASE, metrics);
            const authentication = new StandaloneProjectAuthentication(environment.MOBIUS_STANDALONE_TOKEN);
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
            return metrics.appendServerTiming(await application.fetch(request, context));
        },
    };
    return standalone;
}

const worker: ExportedHandler<StandaloneRelayBindings> = createStandaloneWorker();

export { RuntimeRelay };
export default worker;
