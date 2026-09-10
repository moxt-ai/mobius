import {
    MobiusBotOwnerClient,
    MobiusClient,
    MobiusProjectAuthenticationClient,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

export const MOXT_PROVISIONER_PERMISSIONS = Object.freeze([
    "bot:behavior:write",
    "bot:binding:write",
    "bot:profile:write",
    "bot:read",
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
]);

export const MOXT_CONVERSATION_SERVICE_PERMISSIONS = Object.freeze([
    "bot:read",
    "conversation:create",
    "conversation:read",
    "conversation:turn:cancel",
    "conversation:turn:create",
    "interaction:respond",
    "session:write",
]);

export const MOXT_EVENT_PROJECTOR_PERMISSIONS = Object.freeze([
    "bot:read",
    "conversation:read",
    "project:event:read",
    "project:read",
    "session:read",
]);

export interface MoxtApplicationCredentialVault {
    readonly put: (name: string, credential: string, signal: AbortSignal) => Promise<void>;
}

export class MoxtApplicationProvisioningOptions {
    readonly credentialLifetimeSeconds: number;
    readonly endpoint: string;
    readonly ownerCredential: string;
    readonly projectId: string;

    constructor(endpoint: string, projectId: string, ownerCredential: string, credentialLifetimeSeconds: number) {
        this.endpoint = endpoint;
        this.projectId = projectId;
        this.ownerCredential = ownerCredential;
        this.credentialLifetimeSeconds = credentialLifetimeSeconds;
    }
}

export class MoxtProvisionedApplicationIds {
    readonly conversationServiceApplicationId: string;
    readonly eventProjectorApplicationId: string;
    readonly provisionerApplicationId: string;

    constructor(
        provisionerApplicationId: string,
        conversationServiceApplicationId: string,
        eventProjectorApplicationId: string,
    ) {
        this.provisionerApplicationId = provisionerApplicationId;
        this.conversationServiceApplicationId = conversationServiceApplicationId;
        this.eventProjectorApplicationId = eventProjectorApplicationId;
    }
}

async function createAndStoreApplication(
    authentication: MobiusProjectAuthenticationClient,
    vault: MoxtApplicationCredentialVault,
    name: string,
    permissions: readonly string[],
    lifetimeSeconds: number,
    signal: AbortSignal,
): Promise<string> {
    const application = await authentication.applications.create({ name, permissions }, signal);
    const issued = await authentication.applicationCredentials.issue(
        application.applicationId,
        { expiresInSeconds: lifetimeSeconds },
        signal,
    );
    await vault.put(name, issued.credential, signal);
    return application.applicationId;
}

/**
 * Run once from a trusted Moxt provisioning process. The vault is the only
 * consumer of each plaintext credential, which the Relay returns once.
 */
export async function provisionMoxtApplications(
    options: MoxtApplicationProvisioningOptions,
    vault: MoxtApplicationCredentialVault,
    signal: AbortSignal,
): Promise<MoxtProvisionedApplicationIds> {
    const authentication = new MobiusProjectAuthenticationClient({
        credentialProvider: new StaticMobiusCredentialProvider(options.ownerCredential),
        endpoint: options.endpoint,
        projectId: options.projectId,
    });
    const provisionerApplicationId = await createAndStoreApplication(
        authentication,
        vault,
        "moxt-provisioner",
        MOXT_PROVISIONER_PERMISSIONS,
        options.credentialLifetimeSeconds,
        signal,
    );
    const conversationServiceApplicationId = await createAndStoreApplication(
        authentication,
        vault,
        "moxt-conversation-service",
        MOXT_CONVERSATION_SERVICE_PERMISSIONS,
        options.credentialLifetimeSeconds,
        signal,
    );
    const eventProjectorApplicationId = await createAndStoreApplication(
        authentication,
        vault,
        "moxt-event-projector",
        MOXT_EVENT_PROJECTOR_PERMISSIONS,
        options.credentialLifetimeSeconds,
        signal,
    );
    return new MoxtProvisionedApplicationIds(
        provisionerApplicationId,
        conversationServiceApplicationId,
        eventProjectorApplicationId,
    );
}

export class MoxtServerCredentialSet {
    readonly conversationService: string;
    readonly eventProjector: string;
    readonly provisioner: string;

    constructor(provisioner: string, conversationService: string, eventProjector: string) {
        this.provisioner = provisioner;
        this.conversationService = conversationService;
        this.eventProjector = eventProjector;
    }
}

export class MoxtServerClients {
    readonly #conversationServiceCredential: string;
    readonly #endpoint: string;
    readonly #projectId: string;
    readonly eventProjector: MobiusBotOwnerClient;
    readonly provisionerBots: MobiusBotOwnerClient;
    readonly provisionerProject: MobiusClient;

    constructor(endpoint: string, projectId: string, credentials: MoxtServerCredentialSet) {
        this.#endpoint = endpoint;
        this.#projectId = projectId;
        this.#conversationServiceCredential = credentials.conversationService;
        const provisioner = new StaticMobiusCredentialProvider(credentials.provisioner);
        this.provisionerProject = new MobiusClient({ credentialProvider: provisioner, endpoint, projectId });
        this.provisionerBots = new MobiusBotOwnerClient({ credentialProvider: provisioner, endpoint, projectId });
        this.eventProjector = new MobiusBotOwnerClient({
            actorReference: "moxt-event-projector",
            credentialProvider: new StaticMobiusCredentialProvider(credentials.eventProjector),
            endpoint,
            projectId,
        });
    }

    readonly conversationService = (actorReference: string): MobiusBotOwnerClient =>
        new MobiusBotOwnerClient({
            actorReference,
            credentialProvider: new StaticMobiusCredentialProvider(this.#conversationServiceCredential),
            endpoint: this.#endpoint,
            projectId: this.#projectId,
        });
}
