import { isIdentifier, MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    acceptWebSocketHttpTransport,
    CloudflareChannelRuntime,
    createMobiusApplication,
    createWorkerContext,
    D1DatabaseAdapter,
    instrumentD1Database,
    ProjectPermission,
    RequestAccessMetrics,
} from "@moxt-ai/mobius-relay-core";
import { StandaloneProjectService } from "./service/standalone-project-service.ts";
import { StandaloneDatabaseResolver } from "./standalone-database-resolver.ts";
import { RuntimeRelay } from "./standalone-durable-objects.ts";
import { StandaloneProjectAuthentication } from "./standalone-project-authentication.ts";
import { StandaloneProjectAuthenticationStorage } from "./standalone-project-authentication-storage.ts";
import { StandaloneProjectStorageDirectory } from "./standalone-project-storage-directory.ts";
import { standaloneRecordingProvider } from "./standalone-session-recording.ts";
import { StandaloneProjectStorage } from "./storage/standalone-project-storage.ts";
import { StandaloneRecordingConfigurationStorage } from "./storage/standalone-recording-configuration-storage.ts";

export interface StandaloneRelayBindings {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly MOBIUS_STANDALONE_TOKEN: string;
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
    readonly RUNTIME_RELAY: DurableObjectNamespace<RuntimeRelay>;
}

export interface StandaloneWorker {
    readonly fetch: (request: Request, environment: StandaloneRelayBindings) => Promise<Response>;
}

const application = createMobiusApplication();

function bearerToken(request: Request): string | null {
    return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? null;
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status });
}

function decodedPathIdentifier(value: string | undefined): string | null {
    try {
        const decoded = decodeURIComponent(value ?? "");
        return isIdentifier(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

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
            const databaseAdapter = D1DatabaseAdapter.from(database);
            const projectStorage = new StandaloneProjectStorage(databaseAdapter);
            const authentication = new StandaloneProjectAuthentication(
                environment.MOBIUS_STANDALONE_TOKEN,
                projectStorage,
                new StandaloneProjectAuthenticationStorage(databaseAdapter),
            );
            const recordingConfiguration = new StandaloneRecordingConfigurationStorage(databaseAdapter);
            const recordingProvider = standaloneRecordingProvider(environment);
            const context = createWorkerContext({
                applications: authentication,
                authorization: authentication,
                databases: new StandaloneDatabaseResolver(database),
                identityDatabases: [databaseAdapter],
                projects: new StandaloneProjectStorageDirectory(projectStorage),
                apiPrefix: MOBIUS_API_PREFIX,
                gateways: {
                    channel: new CloudflareChannelRuntime({ gateways: { runtimeRelay: environment.RUNTIME_RELAY } }),
                },
            });
            if (request.method === "POST" && requestUrl.pathname === `${MOBIUS_API_PREFIX}/v1/standalone/projects`) {
                const response = Response.json(
                    await new StandaloneProjectService(projectStorage).create(request.signal),
                    {
                        status: 201,
                    },
                );
                response.headers.set("Cache-Control", "no-store");
                return metrics.appendServerTiming(response);
            }
            const recordingConfigurationMatch = requestUrl.pathname.match(
                new RegExp(`^${MOBIUS_API_PREFIX}/v1/projects/([^/]+)/recording$`, "u"),
            );
            if (recordingConfigurationMatch !== null) {
                const projectId = decodedPathIdentifier(recordingConfigurationMatch[1]);
                const credential = bearerToken(request);
                if (projectId === null) {
                    return metrics.appendServerTiming(
                        errorResponse("invalid_request", "The Recording target is invalid", 400),
                    );
                }
                if (credential === null) {
                    return metrics.appendServerTiming(
                        errorResponse("project_credential_required", "A Project credential is required", 401),
                    );
                }
                try {
                    await authentication.authorizeProject(
                        projectId,
                        credential,
                        ProjectPermission.RuntimePair,
                        request.headers.get("user-agent") ?? "standalone-web",
                        request.signal,
                    );
                } catch {
                    return metrics.appendServerTiming(
                        errorResponse("project_access_denied", "The Project credential is invalid", 401),
                    );
                }
                if (request.method === "GET") {
                    const configuration = await recordingConfiguration.read(projectId, request.signal);
                    return metrics.appendServerTiming(
                        Response.json({
                            ...configuration,
                            providerAvailable: recordingProvider.kind === "available",
                        }),
                    );
                }
                if (request.method === "PUT") {
                    let body: unknown;
                    try {
                        body = await request.json();
                    } catch {
                        return metrics.appendServerTiming(
                            errorResponse("invalid_request", "The Recording choice is invalid", 400),
                        );
                    }
                    if (
                        typeof body !== "object" ||
                        body === null ||
                        Array.isArray(body) ||
                        Object.keys(body).length !== 1 ||
                        typeof Reflect.get(body, "enabled") !== "boolean"
                    ) {
                        return metrics.appendServerTiming(
                            errorResponse("invalid_request", "The Recording choice is invalid", 400),
                        );
                    }
                    const enabled = Reflect.get(body, "enabled") === true;
                    const current = await recordingConfiguration.read(projectId, request.signal);
                    if (current.state === "configured") {
                        return metrics.appendServerTiming(
                            errorResponse(
                                "recording_configuration_locked",
                                "Recording can only be selected before the first Runtime pairing",
                                409,
                            ),
                        );
                    }
                    if (enabled && recordingProvider.kind === "absent") {
                        return metrics.appendServerTiming(
                            errorResponse(
                                "recording_provider_unavailable",
                                "Recording is not installed for this Standalone deployment",
                                409,
                            ),
                        );
                    }
                    const result = await recordingConfiguration.configure(
                        projectId,
                        enabled,
                        Date.now(),
                        request.signal,
                    );
                    if (result.kind === "locked") {
                        return metrics.appendServerTiming(
                            errorResponse(
                                "recording_configuration_locked",
                                "Recording can only be selected before the first Runtime pairing",
                                409,
                            ),
                        );
                    }
                    return metrics.appendServerTiming(
                        Response.json({
                            enabled: result.enabled,
                            providerAvailable: recordingProvider.kind === "available",
                            state: "configured",
                        }),
                    );
                }
                return metrics.appendServerTiming(errorResponse("method_not_allowed", "Method not allowed", 405));
            }
            const recordingDirectoryMatch = requestUrl.pathname.match(
                new RegExp(`^${MOBIUS_API_PREFIX}/v1/projects/([^/]+)/recording/sessions$`, "u"),
            );
            const recordingMatch = requestUrl.pathname.match(
                new RegExp(`^${MOBIUS_API_PREFIX}/v1/projects/([^/]+)/recording/sessions/([^/]+)/events$`, "u"),
            );
            if (request.method === "GET" && recordingDirectoryMatch !== null) {
                const credential = bearerToken(request);
                const projectId = decodedPathIdentifier(recordingDirectoryMatch[1]);
                const runtimeId = requestUrl.searchParams.get("runtimeId") ?? "";
                if (credential === null || projectId === null || !isIdentifier(runtimeId)) {
                    return metrics.appendServerTiming(
                        errorResponse("invalid_request", "The Recording target is invalid", 400),
                    );
                }
                try {
                    await authentication.authorizeProject(
                        projectId,
                        credential,
                        ProjectPermission.SessionRead,
                        request.headers.get("user-agent") ?? "standalone-web",
                        request.signal,
                    );
                } catch {
                    return metrics.appendServerTiming(
                        errorResponse("project_access_denied", "The Project credential is invalid", 401),
                    );
                }
                const configuration = await recordingConfiguration.read(projectId, request.signal);
                if (configuration.state !== "configured" || !configuration.enabled) {
                    return metrics.appendServerTiming(
                        errorResponse("recording_disabled", "Recording is disabled", 404),
                    );
                }
                if (recordingProvider.kind === "absent") {
                    return metrics.appendServerTiming(
                        errorResponse("recording_provider_unavailable", "Recording is unavailable", 503),
                    );
                }
                const response = await recordingProvider.fetcher.fetch(
                    new Request(
                        `https://recording.internal/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(runtimeId)}/sessions`,
                        { signal: request.signal },
                    ),
                );
                return metrics.appendServerTiming(response);
            }
            if (request.method === "GET" && recordingMatch !== null) {
                const credential = bearerToken(request);
                const projectId = decodedPathIdentifier(recordingMatch[1]);
                const sessionId = decodedPathIdentifier(recordingMatch[2]);
                const runtimeId = requestUrl.searchParams.get("runtimeId") ?? "";
                if (credential === null || projectId === null || sessionId === null || !isIdentifier(runtimeId)) {
                    return metrics.appendServerTiming(
                        errorResponse("invalid_request", "The Recording target is invalid", 400),
                    );
                }
                try {
                    await authentication.authorizeProject(
                        projectId,
                        credential,
                        ProjectPermission.SessionRead,
                        request.headers.get("user-agent") ?? "standalone-web",
                        request.signal,
                    );
                } catch {
                    return metrics.appendServerTiming(
                        errorResponse("project_access_denied", "The Project credential is invalid", 401),
                    );
                }
                const configuration = await recordingConfiguration.read(projectId, request.signal);
                if (configuration.state !== "configured" || !configuration.enabled) {
                    return metrics.appendServerTiming(
                        errorResponse("recording_disabled", "Recording is disabled", 404),
                    );
                }
                if (recordingProvider.kind === "absent") {
                    return metrics.appendServerTiming(
                        errorResponse("recording_provider_unavailable", "Recording is unavailable", 503),
                    );
                }
                const response = await recordingProvider.fetcher.fetch(
                    new Request(
                        `https://recording.internal/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/events`,
                        { signal: request.signal },
                    ),
                );
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
