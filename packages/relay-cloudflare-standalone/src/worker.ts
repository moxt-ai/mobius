import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    D1DatabaseAdapter,
    D1ProjectAuthentication,
    type LiteSessionConfigurationEnvironment,
    type PublicProjectBootstrapEnvironment,
    publicProjectBootstrapPolicyFromEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import {
    createBotApplication,
    createLegacyAuthenticationApplication,
    createMobiusApplication,
    createRelayDependencies,
    type ExternalIdentityAuthenticator,
    type ProjectAccessAuthorizer,
    type ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectCredential,
    ProjectCredentialScheme,
    type ProjectPermission,
    StaticSessionQuotaPolicyProvider,
} from "@moxt-ai/mobius-relay-core";
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
const legacyAuthenticationApplication = createLegacyAuthenticationApplication();

export class StandaloneAuthenticationConfiguration {
    readonly externalIdentityAuthenticator: ExternalIdentityAuthenticator;

    constructor(externalIdentityAuthenticator: ExternalIdentityAuthenticator) {
        this.externalIdentityAuthenticator = externalIdentityAuthenticator;
    }
}

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

class AccountlessProjectAccessAuthorizer implements ProjectAccessAuthorizer {
    readonly #authentication: D1ProjectAuthentication;

    constructor(authentication: D1ProjectAuthentication) {
        this.#authentication = authentication;
    }

    readonly authorize = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        if (credential.scheme !== ProjectCredentialScheme.Capability) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "Standalone accepts only accountless Project owner capabilities",
            );
        }
        return await this.#authentication.authorize(credential, requiredPermission, actorReference, signal);
    };

    readonly authorizeProject = async (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const credential = ProjectCredential.decode(credentialValue);
        if (credential.scheme !== ProjectCredentialScheme.Capability) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "Standalone accepts only accountless Project owner capabilities",
            );
        }
        return await this.#authentication.authorizeProject(
            projectId,
            credentialValue,
            requiredPermission,
            actorReference,
            signal,
        );
    };
}

abstract class StandaloneAuthenticationRoutes {
    abstract readonly authorizer: (projectAuthentication: D1ProjectAuthentication) => ProjectAccessAuthorizer;
    abstract readonly handle: (request: Request, projectAuthentication: D1ProjectAuthentication) => Promise<Response>;
    abstract readonly projectResponse: (response: Response) => Promise<Response>;
}

class AccountlessStandaloneAuthenticationRoutes extends StandaloneAuthenticationRoutes {
    readonly authorizer = (projectAuthentication: D1ProjectAuthentication): ProjectAccessAuthorizer =>
        new AccountlessProjectAccessAuthorizer(projectAuthentication);
    readonly handle = async (): Promise<Response> => new Response("Not Found", { status: 404 });
    readonly projectResponse = accountlessResponse;
}

class LegacyStandaloneAuthenticationRoutes extends StandaloneAuthenticationRoutes {
    readonly #authentication: StandaloneAuthenticationConfiguration;

    constructor(authentication: StandaloneAuthenticationConfiguration) {
        super();
        this.#authentication = authentication;
    }

    readonly authorizer = (projectAuthentication: D1ProjectAuthentication): ProjectAccessAuthorizer =>
        projectAuthentication;

    readonly handle = async (request: Request, projectAuthentication: D1ProjectAuthentication): Promise<Response> =>
        await legacyAuthenticationApplication.fetch(request, {
            services: {
                externalIdentityAuthenticator: this.#authentication.externalIdentityAuthenticator,
                projectAuthentication,
            },
        });

    readonly projectResponse = async (response: Response): Promise<Response> => response;
}

function isLegacyAuthenticationPath(pathname: string): boolean {
    if (
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/auth/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-applications/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-application-credentials/`) ||
        pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/project-owner-credentials/`)
    ) {
        return true;
    }
    return /^\/mobius\/api\/v1\/projects\/[^/]+\/(?:applications|external-identity-bindings|owner-credentials|authentication-audit-events)(?:\/|$)/.test(
        pathname,
    );
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

function createConfiguredStandaloneWorker(authenticationRoutes: StandaloneAuthenticationRoutes): StandaloneWorker {
    return {
        fetch: async (request, environment) => {
            const pathname = new URL(request.url).pathname;
            const projectAuthentication = new D1ProjectAuthentication(environment.DIRECTORY_DATABASE);
            if (isLegacyAuthenticationPath(pathname)) {
                return await authenticationRoutes.handle(request, projectAuthentication);
            }
            const infrastructure = {
                config: { quota: sessionQuotaFromEnvironment(environment) },
                gateways: {
                    databaseResolver: new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
                    projectStorageDirectory: new StandaloneProjectStorageDirectory(),
                    runtimeRelay: environment.RUNTIME_RELAY,
                    sessionRelay: environment.SESSION_RELAY,
                },
            };
            const channelRuntime = new CloudflareChannelRuntime(infrastructure);
            const cx = createRelayDependencies({
                authentication: {
                    projects: authenticationRoutes.authorizer(projectAuthentication),
                },
                bots: {
                    connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
                },
                config: {
                    apiPrefix: MOBIUS_API_PREFIX,
                    quotaPolicy: new StaticSessionQuotaPolicyProvider(infrastructure.config.quota),
                },
                databases: infrastructure.gateways.databaseResolver,
                identityDatabases: [D1DatabaseAdapter.from(environment.DIRECTORY_DATABASE)],
                logger: console,
                gateways: {
                    channelGateway: channelRuntime,
                    nowEpochMilliseconds: () => Date.now(),
                    publicProjectBootstrap: publicProjectBootstrapPolicyFromEnvironment(
                        environment.DIRECTORY_DATABASE,
                        environment,
                    ),
                    sessionTransport: new CloudflareSessionTransport(
                        environment.SESSION_RELAY,
                        environment.MOBIUS_TENANT_ID ?? "standalone",
                    ),
                },
                projects: infrastructure.gateways.projectStorageDirectory,
            });
            if (isVersionedSharedProjectPath(pathname)) {
                return await authenticationRoutes.projectResponse(await application.fetch(request, cx));
            }
            if (pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`) && cx.services.bots !== null) {
                return await authenticationRoutes.projectResponse(
                    await botApplication.fetch(request, {
                        services: { bots: cx.services.bots },
                    }),
                );
            }
            return await authenticationRoutes.projectResponse(await application.fetch(request, cx));
        },
    };
}

export function createStandaloneWorker(): StandaloneWorker {
    return createConfiguredStandaloneWorker(new AccountlessStandaloneAuthenticationRoutes());
}

export function createLegacyStandaloneWorker(authentication: StandaloneAuthenticationConfiguration): StandaloneWorker {
    return createConfiguredStandaloneWorker(new LegacyStandaloneAuthenticationRoutes(authentication));
}

const worker: ExportedHandler<RelayBindings> = createStandaloneWorker();

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default worker;
