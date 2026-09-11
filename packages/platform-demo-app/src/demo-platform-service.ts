import {
    MOBIUS_API_PREFIX,
    MobiusApiError,
    MobiusAppCredentialProvider,
    MobiusOidcCredentialProvider,
    type MobiusPlatformApp,
    MobiusPlatformAppClient,
    type MobiusPlatformAuditEvent,
    type MobiusPlatformConfiguration,
    MobiusPlatformDeveloperClient,
    type MobiusPlatformProject,
    type MobiusPlatformTenant,
    type MobiusPlatformTenantUsage,
} from "@moxt-ai/mobius-sdk/platform";
import {
    MobiusBotOwnerClient,
    MobiusClient,
    type MobiusHttpTransport,
    MobiusNoBotCompletionPolicy,
    MobiusPairedRuntimePairingStatus,
    type MobiusRuntimePairing,
    MobiusRuntimePairingRequest,
} from "@moxt-ai/mobius-sdk/server";

export interface DemoPlatformServiceOptions {
    readonly authenticationProviderId: string;
    readonly developerCredential: string;
    readonly endpoint: string;
    readonly transport: MobiusHttpTransport;
}

export class DemoPlatformApp {
    readonly appId: string;
    readonly displayName: string;
    readonly lifecycle: string;
    readonly tenantId: string;

    constructor(app: MobiusPlatformApp) {
        this.appId = app.appId;
        this.displayName = app.displayName;
        this.lifecycle = app.lifecycle;
        this.tenantId = app.tenantId;
    }
}

export class DemoVerificationCheck {
    readonly evidence: string;
    readonly id: string;
    readonly label: string;
    readonly status = "passed";

    constructor(id: string, label: string, evidence: string) {
        this.id = id;
        this.label = label;
        this.evidence = evidence;
    }
}

export class DemoPlatformSnapshot {
    readonly app: DemoPlatformApp;
    readonly auditEvents: readonly MobiusPlatformAuditEvent[];
    readonly checks: readonly DemoVerificationCheck[];
    readonly configuration: MobiusPlatformConfiguration;
    readonly health: string;
    readonly project: MobiusPlatformProject;
    readonly tenant: MobiusPlatformTenant;
    readonly usage: MobiusPlatformTenantUsage;

    constructor(
        health: string,
        configuration: MobiusPlatformConfiguration,
        tenant: MobiusPlatformTenant,
        app: DemoPlatformApp,
        project: MobiusPlatformProject,
        usage: MobiusPlatformTenantUsage,
        auditEvents: readonly MobiusPlatformAuditEvent[],
        checks: readonly DemoVerificationCheck[],
    ) {
        this.health = health;
        this.configuration = configuration;
        this.tenant = tenant;
        this.app = app;
        this.project = project;
        this.usage = usage;
        this.auditEvents = Object.freeze([...auditEvents]);
        this.checks = Object.freeze([...checks]);
    }
}

export class DemoAppCredentialReport {
    readonly issuedCredentialId: string;
    readonly overlapEndsAt: string;
    readonly revokedAccessDenied: boolean;
    readonly revokedAt: string;
    readonly revokedCredentialId: string;
    readonly rotatedCredentialId: string;
    readonly scopeProjectCount: number;

    constructor(
        issuedCredentialId: string,
        rotatedCredentialId: string,
        overlapEndsAt: string,
        revokedCredentialId: string,
        revokedAt: string,
        scopeProjectCount: number,
        revokedAccessDenied: boolean,
    ) {
        this.issuedCredentialId = issuedCredentialId;
        this.rotatedCredentialId = rotatedCredentialId;
        this.overlapEndsAt = overlapEndsAt;
        this.revokedCredentialId = revokedCredentialId;
        this.revokedAt = revokedAt;
        this.scopeProjectCount = scopeProjectCount;
        this.revokedAccessDenied = revokedAccessDenied;
    }
}

export class DemoRuntimePairing {
    readonly channelId: string;
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly runtimeId: string;

    constructor(pairing: MobiusRuntimePairing) {
        this.channelId = pairing.channelId;
        this.expiresAt = pairing.expiresAt;
        this.pairingCode = pairing.pairingCode;
        this.pairingId = pairing.pairingId;
        this.runtimeId = pairing.runtimeId;
    }
}

export class DemoRuntimePairingReport {
    readonly agentLabels: readonly string[];
    readonly machineName: string;
    readonly online: boolean;
    readonly runtimeId: string;
    readonly status: string;
    readonly workspaceName: string;

    constructor(
        status: string,
        runtimeId: string,
        machineName: string,
        workspaceName: string,
        agentLabels: readonly string[],
        online: boolean,
    ) {
        this.status = status;
        this.runtimeId = runtimeId;
        this.machineName = machineName;
        this.workspaceName = workspaceName;
        this.agentLabels = Object.freeze([...agentLabels]);
        this.online = online;
    }
}

export class DemoBotReport {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingStatus: string;
    readonly botId: string;
    readonly displayName: string;
    readonly profileRevision: number;

    constructor(
        botId: string,
        displayName: string,
        profileRevision: number,
        behaviorRevisionId: string,
        bindingId: string,
        bindingStatus: string,
    ) {
        this.botId = botId;
        this.displayName = displayName;
        this.profileRevision = profileRevision;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingStatus = bindingStatus;
    }
}

export class DemoConversationAccess {
    readonly actorRef: string;
    readonly conversationId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly permissions: readonly string[];
    readonly sessionId: string;

    constructor(
        conversationId: string,
        sessionId: string,
        actorRef: string,
        credentialId: string,
        credential: string,
        expiresAt: string,
        permissions: readonly string[],
    ) {
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.actorRef = actorRef;
        this.credentialId = credentialId;
        this.credential = credential;
        this.expiresAt = expiresAt;
        this.permissions = Object.freeze([...permissions]);
    }
}

abstract class DemoPlatformState {}

class EmptyDemoPlatformState extends DemoPlatformState {}

class ProvisionedDemoPlatformState extends DemoPlatformState {
    readonly appCredential: string;
    readonly snapshot: DemoPlatformSnapshot;

    constructor(appCredential: string, snapshot: DemoPlatformSnapshot) {
        super();
        this.appCredential = appCredential;
        this.snapshot = snapshot;
    }
}

class VerifiedCredentialsDemoPlatformState extends ProvisionedDemoPlatformState {
    readonly credentialReport: DemoAppCredentialReport;

    constructor(state: ProvisionedDemoPlatformState, credentialReport: DemoAppCredentialReport) {
        super(state.appCredential, state.snapshot);
        this.credentialReport = credentialReport;
    }
}

abstract class DemoRuntimeState {}

class EmptyDemoRuntimeState extends DemoRuntimeState {}

class PairingDemoRuntimeState extends DemoRuntimeState {
    readonly pairing: DemoRuntimePairing;

    constructor(pairing: DemoRuntimePairing) {
        super();
        this.pairing = pairing;
    }
}

abstract class DemoBotState {}

class EmptyDemoBotState extends DemoBotState {}

class CreatedDemoBotState extends DemoBotState {
    readonly report: DemoBotReport;

    constructor(report: DemoBotReport) {
        super();
        this.report = report;
    }
}

abstract class DemoConversationState {}

class EmptyDemoConversationState extends DemoConversationState {}

class CreatedDemoConversationState extends DemoConversationState {
    readonly access: DemoConversationAccess;

    constructor(access: DemoConversationAccess) {
        super();
        this.access = access;
    }
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The Platform health response is invalid");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function normalizedLabel(value: string): string {
    const label = value.trim();
    if (label.length === 0 || label.length > 64) {
        throw new Error("The demo label must contain between 1 and 64 characters");
    }
    return label;
}

function identifierLabel(value: string): string {
    const normalized = value
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 32);
    return normalized.length === 0 ? "platform-demo" : normalized;
}

export class DemoPlatformService {
    #botState: DemoBotState = new EmptyDemoBotState();
    #conversationState: DemoConversationState = new EmptyDemoConversationState();
    readonly #developer: MobiusPlatformDeveloperClient;
    readonly #endpoint: URL;
    readonly #transport: MobiusHttpTransport;
    #runtimeState: DemoRuntimeState = new EmptyDemoRuntimeState();
    #state: DemoPlatformState = new EmptyDemoPlatformState();

    constructor(options: DemoPlatformServiceOptions) {
        this.#endpoint = new URL(options.endpoint);
        this.#transport = options.transport;
        this.#developer = new MobiusPlatformDeveloperClient({
            authenticationProviderId: options.authenticationProviderId,
            credentialProvider: new MobiusOidcCredentialProvider(options.developerCredential),
            endpoint: this.#endpoint.toString(),
            transport: options.transport,
        });
    }

    readonly provision = async (requestedLabel: string, signal: AbortSignal): Promise<DemoPlatformSnapshot> => {
        if (this.#state instanceof ProvisionedDemoPlatformState) {
            return this.#state.snapshot;
        }
        signal.throwIfAborted();
        const label = normalizedLabel(requestedLabel);
        const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
        const slug = identifierLabel(label);
        const health = await this.readHealth(signal);
        const configuration = await this.#developer.readConfiguration(signal);
        const tenant = await this.#developer.createTenant(`${label} Tenant`, signal);
        const createdApp = await this.#developer.createApp(tenant.tenantId, `${label} App`, signal);
        const project = await this.#developer.createProject(
            createdApp.appId,
            {
                clientReference: `${slug}-${suffix}`,
                displayName: `${label} Project`,
                idempotencyKey: `provision-${slug}-${suffix}`,
                placement: { d1ShardId: "apac-01", r2BucketId: "apac" },
            },
            signal,
        );
        const app = new DemoPlatformApp(await this.#developer.readApp(createdApp.appId, signal));
        const apps = await this.#developer.listApps(tenant.tenantId, signal);
        const projects = await this.#developer.listProjects(createdApp.appId, signal);
        const usage = await this.#developer.readTenantUsage(tenant.tenantId, signal);
        const auditEvents = await this.#developer.listAuditEvents(tenant.tenantId, 100, signal);
        const checks = Object.freeze([
            new DemoVerificationCheck("platform-health", "Independent Platform health", health),
            new DemoVerificationCheck(
                "hosting-profile",
                "Platform hosting boundary",
                `${configuration.hostingProfile}; public bootstrap=${configuration.anonymousPublicBootstrap.toString()}`,
            ),
            new DemoVerificationCheck("tenant", "Tenant provisioning", tenant.tenantId),
            new DemoVerificationCheck(
                "app",
                "App provisioning and read",
                `${app.appId}; listed=${apps.length.toString()}`,
            ),
            new DemoVerificationCheck(
                "project",
                "Project provisioning and idempotent directory",
                `${project.projectId}; listed=${projects.length.toString()}`,
            ),
            new DemoVerificationCheck(
                "usage",
                "Tenant quota accounting",
                `${usage.activeApps.toString()} app / ${usage.activeProjects.toString()} project`,
            ),
            new DemoVerificationCheck("audit", "Platform audit trail", `${auditEvents.length.toString()} events`),
            new DemoVerificationCheck(
                "secret-boundary",
                "AppCredential remains server-only",
                "redacted at API boundary",
            ),
        ]);
        const snapshot = new DemoPlatformSnapshot(
            health,
            configuration,
            tenant,
            app,
            project,
            usage,
            auditEvents,
            checks,
        );
        this.#state = new ProvisionedDemoPlatformState(createdApp.defaultCredential.credential, snapshot);
        return snapshot;
    };

    readonly appCredential = (): string => {
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before using its AppCredential");
        }
        return this.#state.appCredential;
    };

    readonly verifyAppCredentialLifecycle = async (signal: AbortSignal): Promise<DemoAppCredentialReport> => {
        if (this.#state instanceof VerifiedCredentialsDemoPlatformState) {
            return this.#state.credentialReport;
        }
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before verifying AppCredentials");
        }
        const state = this.#state;
        const issued = await this.#developer.issueAppCredential(
            state.snapshot.app.appId,
            {
                expiresInSeconds: 3_600,
                permissions: ["project:read", "runtime:read"],
                projectIds: [state.snapshot.project.projectId],
            },
            signal,
        );
        const issuedClient = new MobiusClient({
            credentialProvider: new MobiusAppCredentialProvider(issued.credential),
            endpoint: this.#endpoint.toString(),
            projectId: state.snapshot.project.projectId,
            transport: this.#transport,
        });
        try {
            await issuedClient.runtimes.list(signal);
        } finally {
            issuedClient.close();
        }
        const rotated = await this.#developer.rotateAppCredential(issued.credentialId, 3_600, 60, signal);
        const rotatedClient = new MobiusClient({
            credentialProvider: new MobiusAppCredentialProvider(rotated.credential),
            endpoint: this.#endpoint.toString(),
            projectId: state.snapshot.project.projectId,
            transport: this.#transport,
        });
        let revokedAccessDenied = false;
        let revokedAt = "";
        try {
            await rotatedClient.runtimes.list(signal);
            const revocation = await this.#developer.revokeAppCredential(rotated.credentialId, signal);
            revokedAt = revocation.revokedAt;
            try {
                await rotatedClient.runtimes.list(signal);
            } catch (error) {
                if (error instanceof MobiusApiError && error.status === 401) {
                    revokedAccessDenied = true;
                } else {
                    throw error;
                }
            }
        } finally {
            rotatedClient.close();
        }
        if (!revokedAccessDenied) {
            throw new Error("The revoked AppCredential remained authorized");
        }
        const report = new DemoAppCredentialReport(
            issued.credentialId,
            rotated.credentialId,
            rotated.overlapEndsAt,
            rotated.credentialId,
            revokedAt,
            1,
            revokedAccessDenied,
        );
        this.#state = new VerifiedCredentialsDemoPlatformState(state, report);
        return report;
    };

    readonly createRuntimePairing = async (signal: AbortSignal): Promise<DemoRuntimePairing> => {
        if (this.#runtimeState instanceof PairingDemoRuntimeState) {
            return this.#runtimeState.pairing;
        }
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before pairing a Runtime");
        }
        const client = this.projectClient(this.#state);
        try {
            const pairing = await client.runtimePairings.create(
                new MobiusRuntimePairingRequest(`platform-demo-${crypto.randomUUID()}`),
                signal,
            );
            const safePairing = new DemoRuntimePairing(pairing);
            this.#runtimeState = new PairingDemoRuntimeState(safePairing);
            return safePairing;
        } finally {
            client.close();
        }
    };

    readonly readRuntimePairing = async (signal: AbortSignal): Promise<DemoRuntimePairingReport> => {
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before reading a Runtime");
        }
        if (!(this.#runtimeState instanceof PairingDemoRuntimeState)) {
            throw new Error("Create a Runtime pairing before reading its status");
        }
        const state = this.#state;
        const pairing = this.#runtimeState.pairing;
        const client = this.projectClient(state);
        try {
            const status = await client.runtimePairings.read(pairing.pairingId, signal);
            if (!(status instanceof MobiusPairedRuntimePairingStatus)) {
                return new DemoRuntimePairingReport(status.status, pairing.runtimeId, "", "", [], false);
            }
            const runtimes = await client.runtimes.list(signal);
            const runtime = runtimes.find((candidate) => candidate.runtimeId === status.runtimeId);
            if (runtime === undefined) {
                throw new Error("The paired Runtime was missing from the Project directory");
            }
            return new DemoRuntimePairingReport(
                status.status,
                status.runtimeId,
                status.machineName,
                status.workspaceName,
                status.agents.map((agent) => agent.label),
                runtime.online,
            );
        } finally {
            client.close();
        }
    };

    readonly createBot = async (signal: AbortSignal): Promise<DemoBotReport> => {
        if (this.#botState instanceof CreatedDemoBotState) {
            return this.#botState.report;
        }
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before creating a Bot");
        }
        if (!(this.#runtimeState instanceof PairingDemoRuntimeState)) {
            throw new Error("Pair a Runtime before creating a Bot");
        }
        const project = this.projectClient(this.#state);
        let runtimeId = "";
        let agentRef = "";
        try {
            const status = await project.runtimePairings.read(this.#runtimeState.pairing.pairingId, signal);
            if (!(status instanceof MobiusPairedRuntimePairingStatus)) {
                throw new Error("The Runtime pairing is not complete");
            }
            const runtime = (await project.runtimes.list(signal)).find(
                (candidate) => candidate.runtimeId === status.runtimeId,
            );
            if (runtime === undefined || !runtime.online) {
                throw new Error("The paired Runtime is not online");
            }
            const agent = status.agents.at(0);
            if (agent === undefined) {
                throw new Error("The paired Runtime has no ready Agent");
            }
            runtimeId = status.runtimeId;
            agentRef = agent.id;
        } finally {
            project.close();
        }

        const owner = this.botOwnerClient(this.#state);
        const created = await owner.createBot(
            {
                avatarRef: "",
                description: "Exercises the Mobius Platform through the production SDK boundaries.",
                displayName: "Platform Demo Assistant",
            },
            signal,
        );
        await owner.reviseProfile(
            created.botId,
            {
                avatarRef: "",
                description: "A verified Runtime-backed assistant for the Platform demo application.",
                displayName: "Platform Demo Assistant",
                expectedRevision: created.lifecycleRevision,
            },
            signal,
        );
        const profiled = await owner.readBot(created.botId, signal);
        const behavior = await owner.createBehavior(
            created.botId,
            {
                agentConfiguration: {},
                expectedRevision: 0,
                instructions: "Answer clearly and briefly. State that the response travelled through Mobius Platform.",
                requiredCapabilities: [],
            },
            signal,
        );
        const beforeBinding = await owner.readBot(created.botId, signal);
        const binding = await owner.createBinding(
            created.botId,
            {
                agentConfigRevision: 1,
                agentRef,
                allowedDeliveryTargetIds: [],
                behaviorRevisionId: behavior.behaviorRevisionId,
                completionPolicy: new MobiusNoBotCompletionPolicy(),
                expectedRevision: beforeBinding.lifecycleRevision,
                runtimeId,
                workspaceRef: "default",
            },
            signal,
        );
        const bots = await owner.listBots(signal);
        const behaviors = await owner.listBehaviors(created.botId, signal);
        if (
            !bots.bots.some((candidate) => candidate.botId === created.botId) ||
            !behaviors.behaviorRevisions.some(
                (candidate) => candidate.behaviorRevisionId === behavior.behaviorRevisionId,
            )
        ) {
            throw new Error("The created Bot was missing from its Platform directory");
        }
        const report = new DemoBotReport(
            created.botId,
            profiled.displayName,
            profiled.profileRevision,
            behavior.behaviorRevisionId,
            binding.bindingId,
            binding.lifecycle,
        );
        this.#botState = new CreatedDemoBotState(report);
        return report;
    };

    readonly createConversationAccess = async (signal: AbortSignal): Promise<DemoConversationAccess> => {
        if (this.#conversationState instanceof CreatedDemoConversationState) {
            return this.#conversationState.access;
        }
        if (!(this.#state instanceof ProvisionedDemoPlatformState)) {
            throw new Error("Provision the Platform demo before creating a Conversation");
        }
        if (!(this.#botState instanceof CreatedDemoBotState)) {
            throw new Error("Create a Bot before creating a Conversation");
        }
        const state = this.#state;
        const bot = this.#botState.report;
        const owner = this.botOwnerClient(state);
        const bindings = await owner.listBindings(bot.botId, signal);
        const binding = bindings.executionBindings.find((candidate) => candidate.bindingId === bot.bindingId);
        if (binding === undefined || binding.state.kind !== "approved") {
            throw new Error("The local Runtime has not approved the Bot binding yet");
        }
        const conversation = await owner.createConversation(
            bot.botId,
            { clientConversationKey: `platform-demo-${crypto.randomUUID()}` },
            signal,
        );
        const conversations = await owner.listConversations(bot.botId, signal);
        if (
            !conversations.conversations.some((candidate) => candidate.conversationId === conversation.conversationId)
        ) {
            throw new Error("The created Conversation was missing from the Bot directory");
        }
        const application = new MobiusPlatformAppClient({
            credentialProvider: new MobiusAppCredentialProvider(state.appCredential),
            endpoint: this.#endpoint.toString(),
            transport: this.#transport,
        });
        const actorRef = "platform-demo-browser";
        const permissions = Object.freeze([
            "artifact:read",
            "artifact:write",
            "conversation:configure",
            "conversation:event:read",
            "conversation:message:create",
            "conversation:read",
            "conversation:turn:cancel",
            "conversation:turn:create",
            "interaction:respond",
        ]);
        const issued = await application.issueConversationAccessCredential(
            conversation.conversationId,
            { actorRef, expiresInSeconds: 30 * 60, permissions },
            signal,
        );
        const access = new DemoConversationAccess(
            conversation.conversationId,
            conversation.sessionId,
            actorRef,
            issued.credentialId,
            issued.credential,
            issued.expiresAt,
            issued.permissions,
        );
        this.#conversationState = new CreatedDemoConversationState(access);
        return access;
    };

    private readonly projectClient = (state: ProvisionedDemoPlatformState): MobiusClient =>
        new MobiusClient({
            credentialProvider: new MobiusAppCredentialProvider(state.appCredential),
            endpoint: this.#endpoint.toString(),
            projectId: state.snapshot.project.projectId,
            transport: this.#transport,
        });

    private readonly botOwnerClient = (state: ProvisionedDemoPlatformState): MobiusBotOwnerClient =>
        new MobiusBotOwnerClient({
            actorReference: "platform-demo-operator",
            credentialProvider: new MobiusAppCredentialProvider(state.appCredential),
            endpoint: this.#endpoint.toString(),
            projectId: state.snapshot.project.projectId,
            transport: this.#transport,
        });

    private readonly readHealth = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const response = await this.#transport.fetch(
            new Request(new URL(`${MOBIUS_API_PREFIX}/health`, this.#endpoint), { signal }),
        );
        if (!response.ok) {
            throw new Error(`Platform health failed with HTTP ${response.status.toString()}`);
        }
        const body = responseRecord(await response.json());
        if (body["service"] !== "mobius-relay-platform" || body["status"] !== "ok") {
            throw new Error("The Platform health response is invalid");
        }
        return "ok";
    };
}
