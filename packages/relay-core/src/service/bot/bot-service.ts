import {
    AGENT_PERMISSION_MODE_CONFIG_ID,
    type AgentExecutionConfiguration,
    type BotCompletionDeliveryPolicy,
    BotConnectionReplyRoute,
    BotDeliveryTargetReference,
    conversationTitleFromText,
    DraftBot,
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    type PromptImage,
    type PromptResource,
    RequiredBotCompletionDeliveryPolicy,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    type SessionConfigOption,
    type SessionPrepareCommand,
    type SessionReadyEvent,
} from "@moxt-ai/mobius-protocol";
import {
    type ConversationAccessContext,
    ConversationPermission,
} from "../../entity/authentication/conversation-access.ts";
import { type ExecutionPermit, ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import {
    BotConnectionAccess,
    type BotConversationAuthorization,
    type BotRuntimeExecutionAccess,
    ConversationBotAccess,
    ProjectBotAccess,
} from "../../entity/bot/bot-access.ts";
import {
    type ActiveBindingContext,
    completionPolicy,
    executionConfiguration,
    sessionConfigurations,
    stringArray,
} from "../../entity/bot/bot-binding.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import type { BotBehaviorRevision, BotProfileRevision } from "../../entity/bot/bot-revisions.ts";
import { BotOutboundSubmission, type BotSessionRuntime, BotTurnSubmission } from "../../entity/bot/bot-session.ts";
import { type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import {
    type ChannelHostCredential,
    createRandomToken,
    hashSecret,
    parseAgents,
    VerifiedChannelAccess,
    validateIdentifier,
} from "../../entity/pairing/pairing.ts";
import type { BotConnectionGateway } from "../../gateway/bot-connection-gateway.ts";
import type { ChannelGateway, SessionCommandGateway, SessionQueryGateway } from "../../gateway/index.ts";
import type { SessionArtifactGateway } from "../../gateway/session-artifact-gateway.ts";
import { type OperationTiming, unmeasuredOperationTiming } from "../../infra/operation-timing.ts";
import type { BotConnectionStorage } from "../../storage/bot-connection-storage.ts";
import type { BotControlStorage } from "../../storage/bot-control-storage.ts";
import type { BotConversationStorage } from "../../storage/bot-conversation-storage.ts";
import { requestRuntimeControl } from "../pairing/runtime-control-request.ts";
import type { BotAuthorization } from "./bot-authorization.ts";
import type { BotConversationService } from "./bot-conversation-service.ts";
import { connectorEventPage } from "./bot-event-visibility.ts";
import type { BotManagementService } from "./bot-management-service.ts";
import { botResource } from "./bot-resource.ts";
import type { BotTargetService } from "./bot-target-service.ts";

const BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const BOT_CONNECTION_CREDENTIAL_OVERLAP_MILLISECONDS = 5 * 60 * 1_000;
const BOT_CONVERSATION_EVENT_PAGE_LIMIT = 20;

type ProjectConversationConfiguration = NonNullable<SessionPrepareCommand["configuration"]> & {
    readonly additionalDirectoryIds: readonly string[];
};

interface CreateProjectConversationResourceRequest {
    readonly botId: string;
    readonly clientReference: string;
    readonly configuration?: ProjectConversationConfiguration;
    readonly idempotencyKey: string;
    readonly title: string;
}

interface PrepareProjectConversationRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly expectedConfiguration?: ProjectConversationConfiguration;
    readonly initialConfiguration?: ProjectConversationConfiguration;
}

function assertPinnedExecutionPermit(runtime: BotRuntimeExecutionAccess, permit: ExecutionPermit, now: number): void {
    if (
        permit.scope.projectId !== runtime.scope.projectId ||
        permit.scope.projectId !== runtime.scope.projectId ||
        permit.executionId !== runtime.executionId ||
        permit.capabilityId !== runtime.capabilityId ||
        permit.botId !== runtime.botId ||
        permit.conversationId !== runtime.conversationId ||
        permit.sessionId !== runtime.sessionId ||
        permit.turnId !== runtime.turnId ||
        permit.behaviorRevisionId !== runtime.behaviorRevisionId ||
        permit.bindingId !== runtime.bindingId ||
        permit.bindingRevision !== runtime.bindingRevision ||
        permit.runtimeId !== runtime.runtimeId ||
        permit.operation !== "outbound-message:create" ||
        permit.expiresAtEpochMilliseconds <= now ||
        permit.remainingUses < 1
    ) {
        throw new SessionRuntimeError(
            "execution_context_mismatch",
            "The execution permit does not match the authenticated Runtime context",
        );
    }
}

import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";

export interface BotProjectStorageContext {
    readonly services: {
        readonly targets: BotTargetService;
        readonly conversations: BotConversationService;
        readonly management: BotManagementService;
    };
    readonly storages: {
        readonly connections: BotConnectionStorage;
        readonly control: BotControlStorage;
        readonly conversations: BotConversationStorage;
    };
}

export interface BotServiceContext {
    readonly services: {
        readonly authorization: BotAuthorization;
        readonly controls: {
            readonly close: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
            readonly open: (
                scope: ProjectScope,
                runtimeId: string,
                signal: AbortSignal,
            ) => Promise<ChannelHostCredential>;
        };
    };
    readonly forProject: (project: ProjectStorageContext) => BotProjectStorageContext;
    readonly gateways: {
        readonly projects: ProjectStorageDirectory;
        readonly channels: ChannelGateway;
        readonly connections: BotConnectionGateway;
        readonly botSessions: BotSessionRuntime;
        readonly sessions: SessionCommandGateway & SessionQueryGateway & SessionArtifactGateway;
    };
}

interface AuthorizedBotConversation {
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly conversationId: string;
    readonly sessionId: string;
}

export type NewBotConversation =
    | { readonly kind: "owner"; readonly clientConversationKey: string }
    | {
          readonly kind: "connection";
          readonly clientConversationKey: string;
          readonly title: string;
          readonly replyDeliveryTargetId: string;
      };

export type NewBotMessage = {
    readonly clientMessageId: string;
    readonly actorRef: string;
    readonly text: string;
} & (
    | { readonly kind: "owner"; readonly artifactIds: readonly string[] }
    | { readonly kind: "connection"; readonly resourceRefs: readonly string[] }
);

export class BotService {
    private readonly cx: BotServiceContext;

    constructor(cx: BotServiceContext) {
        this.cx = cx;
    }

    readonly forProject = (projectId: string): BotService =>
        new BotService({
            ...this.cx,
            services: { ...this.cx.services, authorization: this.cx.services.authorization.forProject(projectId) },
        });

    private readonly context = async (projectId: string, signal: AbortSignal) => {
        const project = await this.cx.gateways.projects.resolve(projectId, signal);
        signal.throwIfAborted();
        if (project.projectId !== projectId) {
            throw new BotApiError("bot_service_unavailable", "The Project placement is invalid", "unavailable");
        }
        return this.cx.forProject(project);
    };

    private readonly projectContext = async (scope: ProjectScope, signal: AbortSignal) => {
        const project = await this.cx.gateways.projects.resolve(scope.projectId, signal);
        signal.throwIfAborted();
        if (project.projectId !== scope.projectId) {
            throw new BotApiError("bot_service_unavailable", "The Project placement is invalid", "unavailable");
        }
        return this.cx.forProject(project);
    };

    private readonly readLifecycle = async (cx: BotProjectStorageContext, botId: string, signal: AbortSignal) => {
        const bot = await cx.storages.control.readLifecycle(botId, signal);
        if (bot === null) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
        }
        return bot;
    };

    readonly listOwnedBots = async (projectId: string, token: string, actorReference: string, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeProject(
            projectId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return cx.services.management.listBots(access, signal);
    };

    readonly listBehaviorRevisions = async (
        botId: string,
        token: string,
        actorReference: string,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return cx.services.management.listBehaviorRevisions(access, signal);
    };

    readonly listExecutionBindings = async (
        botId: string,
        token: string,
        actorReference: string,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return cx.services.management.listExecutionBindings(access, signal);
    };

    /**
     * @deprecated Retained for compatibility with the Bot-scoped Agent-configuration API.
     * Use Runtime Agent settings discovery for new integrations.
     */
    readonly inspectAgentConfiguration = async (
        botId: string,
        token: string,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<readonly SessionConfigOption[]> => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotBindingWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const binding = await this.readActiveBinding(cx, access.botId, signal);
        const runtime = await cx.storages.control.readBindingRuntime(access.scope, binding.runtimeId, signal);
        if (runtime === null) {
            throw new BotApiError("binding_incompatible", "The selected Runtime is unavailable", "conflict");
        }
        const agent = parseAgents(runtime.agents_json).find((candidate) => candidate.id === binding.agentRef);
        if (agent?.botSessionConfiguration !== true) {
            throw new BotApiError(
                "binding_incompatible",
                "Update the local Mobius CLI before configuring this Agent",
                "conflict",
            );
        }
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        let control: ChannelHostCredential;
        try {
            control = await this.cx.services.controls.open(access.scope, runtime.runtime_id, deadline);
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotApiError("bot_service_unavailable", "The selected Runtime is unavailable", "unavailable", {
                cause,
            });
        }
        try {
            try {
                const response = await this.cx.gateways.channels.acceptHost(
                    control,
                    new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                    deadline,
                );
                if (response.webSocket === null) {
                    throw new BotApiError(
                        "bot_service_unavailable",
                        "The selected Runtime is unavailable",
                        "unavailable",
                    );
                }
                const requestId = `cfg_${createRandomToken(18)}`;
                const result = await requestRuntimeControl(
                    response.webSocket,
                    decodeSessionPrepareCommand(
                        JSON.stringify({
                            additionalDirectoryIds: [],
                            agentId: binding.agentRef,
                            bindingId: binding.bindingId,
                            directoryId: binding.workspaceRef,
                            kind: SESSION_PREPARE_KIND,
                            requestId,
                            sessionId: `cfg_${createRandomToken(18)}`,
                            transient: true,
                        }),
                    ),
                    deadline,
                );
                if (
                    result.kind !== "session.ready" ||
                    result.agentId !== binding.agentRef ||
                    result.directoryId !== binding.workspaceRef
                ) {
                    throw new BotApiError(
                        "bot_service_unavailable",
                        "The local Agent did not return a configuration snapshot",
                        "unavailable",
                    );
                }
                return result.configOptions;
            } catch (cause) {
                if (cause instanceof BotApiError) {
                    throw cause;
                }
                signal.throwIfAborted();
                throw new BotApiError(
                    "bot_service_unavailable",
                    "The local Agent configuration is temporarily unavailable",
                    "unavailable",
                    { cause },
                );
            }
        } finally {
            try {
                await this.cx.services.controls.close(control, AbortSignal.timeout(15_000));
            } catch (cause) {
                console.warn("Mobius could not close the temporary Agent configuration control host", cause);
            }
        }
    };

    readonly listConnections = async (botId: string, token: string, actorReference: string, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return cx.services.management.listConnections(access, signal);
    };

    readonly listConversations = async (botId: string, token: string, actorReference: string, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.ConversationRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return cx.services.management.listConversations(access, signal);
    };

    readonly createProjectConversationResource = async (
        projectId: string,
        token: string,
        actorReference: string,
        request: CreateProjectConversationResourceRequest,
        now: number,
        signal: AbortSignal,
        timing: OperationTiming,
    ) => {
        const access = await timing.measure(
            "create-authorize",
            "Authorize conversation creation",
            async () =>
                await this.cx.services.authorization.authorizeProjectBot(
                    request.botId,
                    token,
                    ProjectPermission.ConversationCreate,
                    actorReference,
                    signal,
                ),
        );
        if (access.scope.projectId !== validateIdentifier(projectId, "project_id")) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
        }
        const cx = await timing.measure(
            "create-context",
            "Resolve project context",
            async () => await this.projectContext(access.scope, signal),
        );
        const execution = await timing.measure(
            "create-binding",
            "Read active Bot execution context",
            async () => await this.readActiveConversationExecution(cx, access.scope, request.botId, signal),
        );
        await timing.measure("create-runtime", "Verify Runtime access", async () => {
            if (execution.runtimeId !== execution.binding.runtimeId) {
                throw new BotApiError("binding_incompatible", "The selected Runtime is unavailable", "conflict");
            }
        });
        const { binding } = execution;
        const plan = await timing.measure(
            "create-plan",
            "Plan conversation creation",
            async () =>
                await cx.services.conversations.createCanonicalProjectConversation(
                    access,
                    binding,
                    validateIdentifier(request.idempotencyKey, "idempotency_key"),
                    validateIdentifier(request.clientReference, "client_reference"),
                    request.title,
                    now,
                    signal,
                ),
        );
        const session = await timing.measure("create-provision", "Provision conversation Session", async () => {
            const provisioned = await timing.measure(
                "create-provision-command",
                "Execute conversation Session provisioning",
                async () =>
                    await this.cx.gateways.botSessions.provisionConversation(
                        access.scope,
                        plan.provisioning,
                        now,
                        signal,
                        timing,
                    ),
            );
            await timing.measure("create-provision-verify", "Verify provisioned conversation Session", async () => {
                if (
                    provisioned.projectId !== access.scope.projectId ||
                    provisioned.sessionId !== plan.provisioning.sessionId ||
                    provisioned.runtimeId !== binding.runtimeId ||
                    provisioned.agentId !== binding.agentRef ||
                    provisioned.defaultBinding.bindingId !== binding.bindingId ||
                    provisioned.defaultBinding.runtimeId !== binding.runtimeId ||
                    provisioned.defaultBinding.agentRef !== binding.agentRef ||
                    provisioned.defaultBinding.workspaceRef !== binding.workspaceRef ||
                    provisioned.lifecycle.kind !== "ready"
                ) {
                    throw new BotApiError(
                        "bot_service_unavailable",
                        "The provisioned conversation Session is invalid",
                        "unavailable",
                    );
                }
            });
            return provisioned;
        });
        const activatedConversation = await timing.measure(
            "create-activate",
            "Activate conversation",
            async () =>
                await cx.services.conversations.activateProjectConversation(
                    access.scope,
                    plan.provisioning.conversationId,
                    now,
                    signal,
                ),
        );
        const conversation = await timing.measure(
            "create-read",
            "Reuse activated conversation",
            async () => activatedConversation,
        );
        const ready = await timing.measure(
            "prepare",
            "Prepare configured conversation Session",
            async () =>
                await this.prepareProjectConversation(
                    access.scope,
                    binding,
                    session.sessionId,
                    validateIdentifier(request.idempotencyKey, "idempotency_key"),
                    {
                        additionalDirectoryIds: request.configuration?.additionalDirectoryIds ?? [],
                        ...(plan.kind === "provisioning" && request.configuration !== undefined
                            ? { initialConfiguration: request.configuration }
                            : {}),
                        ...(request.configuration === undefined
                            ? {}
                            : { expectedConfiguration: request.configuration }),
                    },
                    signal,
                    timing,
                ),
        );
        return { ...conversation, ready };
    };

    private readonly prepareProjectConversation = async (
        scope: ProjectScope,
        binding: ActiveBindingContext,
        sessionId: string,
        requestId: string,
        preparation: PrepareProjectConversationRequest,
        signal: AbortSignal,
        timing: OperationTiming,
    ): Promise<SessionReadyEvent> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const control = await timing.measure(
            "prepare-control-authorize",
            "Authorize conversation Runtime control host",
            async () => await this.cx.services.controls.open(scope, binding.runtimeId, deadline),
        );
        try {
            const response = await timing.measure(
                "prepare-control-connect",
                "Connect conversation Runtime control host",
                async () =>
                    await this.cx.gateways.channels.acceptHost(
                        control,
                        new Request("https://runtime.internal/host", { headers: { Upgrade: "websocket" } }),
                        deadline,
                    ),
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new BotApiError("bot_service_unavailable", "The selected Runtime is unavailable", "unavailable");
            }
            const command = decodeSessionPrepareCommand(
                JSON.stringify({
                    additionalDirectoryIds: preparation.additionalDirectoryIds,
                    agentId: binding.agentRef,
                    bindingId: binding.bindingId,
                    ...(preparation.initialConfiguration === undefined
                        ? {}
                        : {
                              configuration: {
                                  booleanValue: preparation.initialConfiguration.booleanValue,
                                  configId: preparation.initialConfiguration.configId,
                                  value: preparation.initialConfiguration.value,
                                  valueType: preparation.initialConfiguration.valueType,
                              },
                          }),
                    directoryId: binding.workspaceRef,
                    kind: SESSION_PREPARE_KIND,
                    requestId,
                    sessionId,
                    sessionState: "provisioned",
                }),
            );
            const daemonStartedAt = performance.now();
            const result = await timing
                .measure(
                    "prepare-control-runtime",
                    "Wait for configured Runtime Session",
                    async () => await requestRuntimeControl(socket, command, deadline),
                )
                .catch((error: unknown) => {
                    const durationMilliseconds = Math.max(0, performance.now() - daemonStartedAt);
                    if (error instanceof SessionRuntimeError) {
                        this.recordRuntimeTimings(error.runtimeTimings, timing);
                        this.recordDaemonAccess(error.runtimeTimings, durationMilliseconds, timing);
                    } else {
                        this.recordDaemonAccess([], durationMilliseconds, timing);
                    }
                    throw error;
                });
            if (result.kind !== "session.ready") {
                throw new BotApiError(
                    "binding_incompatible",
                    "The local Agent did not confirm conversation readiness",
                    "conflict",
                );
            }
            const runtimeTimings = result.runtimeTimings ?? [];
            this.recordRuntimeTimings(runtimeTimings, timing);
            this.recordDaemonAccess(runtimeTimings, Math.max(0, performance.now() - daemonStartedAt), timing);
            const expectedConfiguration = preparation.expectedConfiguration;
            const matchesExpectedConfiguration =
                expectedConfiguration === undefined ||
                result.configOptions.some(
                    (option) =>
                        option.id === expectedConfiguration.configId &&
                        option.currentValue === expectedConfiguration.value,
                );
            if (
                result.sessionId !== sessionId ||
                result.agentId !== binding.agentRef ||
                result.directoryId !== binding.workspaceRef ||
                !matchesExpectedConfiguration
            ) {
                throw new BotApiError(
                    "binding_incompatible",
                    "The local Agent did not confirm the initial conversation configuration",
                    "conflict",
                );
            }
            return result;
        } finally {
            await timing.measure(
                "prepare-control-close",
                "Close conversation Runtime control host",
                async () => await this.cx.services.controls.close(control, AbortSignal.timeout(15_000)),
            );
        }
    };

    private readonly recordRuntimeTimings = (
        runtimeTimings: NonNullable<SessionReadyEvent["runtimeTimings"]>,
        timing: OperationTiming,
    ): void => {
        const descriptions: Readonly<Record<string, string>> = {
            "agent-initialize": "Initialize ACP agent",
            configuration: "Apply initial agent configuration",
            "executable-validation": "Validate ACP executables",
            "prepare-total": "Prepare local Runtime Session",
            "process-spawn": "Spawn ACP process",
            "readiness-commit": "Commit Runtime Session readiness",
            "runtime-replacement-close": "Close replaced ACP runtime",
            "session-fork": "Fork ACP Session",
            "session-load": "Load ACP Session",
            "session-new": "Create ACP Session",
            "session-preparation-wait": "Wait for concurrent Session preparation",
            "session-resume": "Resume ACP Session",
            "session-state-read": "Read persisted Session state",
            "workspace-list": "Read workspace metadata",
            "workspace-resolve": "Resolve authorized workspaces",
        };
        for (const metric of runtimeTimings) {
            const description = descriptions[metric.name];
            if (description !== undefined) {
                timing.record(`runtime-${metric.name}`, description, metric.durationMilliseconds);
            }
        }
    };

    private readonly recordDaemonAccess = (
        runtimeTimings: NonNullable<SessionReadyEvent["runtimeTimings"]>,
        durationMilliseconds: number,
        timing: OperationTiming,
    ): void => {
        const localPreparation = runtimeTimings.find((metric) => metric.name === "prepare-total");
        if (localPreparation !== undefined) {
            timing.record(
                "prepare-control-runtime-relay",
                "Wait for Runtime relay transport",
                Math.max(0, durationMilliseconds - localPreparation.durationMilliseconds),
            );
        }
        timing.record("daemon-access-total", "Total daemon access time", durationMilliseconds);
        timing.record("daemon-access-count", "Daemon access count", 1);
    };

    readonly readProjectConversationResource = async (
        conversationId: string,
        token: string,
        actorReference: string,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectConversation(
            conversationId,
            token,
            ProjectPermission.ConversationRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return await cx.services.conversations.projectResource(access, access.conversationId, signal);
    };

    readonly submitProjectConversationTurn = async (
        conversationId: string,
        token: string,
        actorReference: string,
        idempotencyKey: string,
        content: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        disposition: string,
        targetTurnId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectConversation(
            conversationId,
            token,
            ProjectPermission.ConversationTurnCreate,
            actorReference,
            signal,
        );
        if (artifactIds.length > 0) {
            await this.cx.services.authorization.authorizeProjectConversation(
                conversationId,
                token,
                ProjectPermission.ArtifactRead,
                actorReference,
                signal,
            );
        }
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, access.conversationId, signal);
        const artifactResources = await this.cx.gateways.sessions.resolveArtifactResources(
            access.scope,
            access.sessionId,
            artifactIds,
            signal,
        );
        const accepted = await this.acceptAuthorizedMessage(
            cx,
            access,
            conversation,
            new BotTurnSubmission(
                validateIdentifier(idempotencyKey, "idempotency_key"),
                actorReference.length > 0 ? actorReference : access.actor.actorId,
                content,
                additionalDirectoryIds,
                images,
                [...resources, ...artifactResources],
                disposition,
                targetTurnId,
            ),
            now,
            signal,
        );
        return {
            ...accepted,
            turn: await this.cx.gateways.sessions.readTurn(access.scope, access.sessionId, accepted.turnId, signal),
        };
    };

    readonly configureProjectConversation = async (
        conversationId: string,
        token: string,
        actorReference: string,
        idempotencyKey: string,
        additionalDirectoryIds: readonly string[],
        configId: string,
        value: string,
        booleanValue: boolean,
        valueType: string,
        now: number,
        signal: AbortSignal,
        timing: OperationTiming,
    ) => {
        const access = await timing.measure(
            "configure-authorize",
            "Authorize conversation configuration",
            async () =>
                await this.cx.services.authorization.authorizeProjectConversation(
                    conversationId,
                    token,
                    ProjectPermission.SessionWrite,
                    actorReference,
                    signal,
                ),
        );
        const cx = await timing.measure(
            "configure-context",
            "Resolve configuration project context",
            async () => await this.projectContext(access.scope, signal),
        );
        await timing.measure(
            "configure-conversation",
            "Authorize configured conversation",
            async () => await this.authorizeConversation(cx, access, access.conversationId, signal),
        );
        const session = await timing.measure(
            "configure-session",
            "Read configured Session",
            async () => await this.cx.gateways.sessions.readSession(access.scope, access.sessionId, signal),
        );
        const runtime = await timing.measure(
            "configure-runtime",
            "Verify configuration Runtime",
            async () => await this.readRuntimeAccess(cx, access.scope, session.defaultBinding.runtimeId, signal),
        );
        const command = decodeSessionConfigureCommand(
            JSON.stringify({
                additionalDirectoryIds,
                agentId: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                booleanValue,
                configId,
                directoryId: session.defaultBinding.workspaceRef,
                kind: SESSION_CONFIGURE_KIND,
                requestId: validateIdentifier(idempotencyKey, "idempotency_key"),
                sessionId: access.sessionId,
                value,
                valueType,
            }),
        );
        const acceptance = await timing.measure(
            "configure-accept",
            "Accept Session configuration",
            async () =>
                await this.cx.gateways.sessions.acceptConfiguration(
                    access.scope,
                    runtime.runtimeId,
                    command,
                    now,
                    signal,
                ),
        );
        if (acceptance.pendingWork.state.kind !== "completed") {
            await timing.measure(
                "configure-dispatch",
                "Dispatch Session configuration",
                async () => await this.cx.gateways.channels.dispatchPending(runtime, signal),
            );
        }
        return acceptance;
    };

    readonly promoteProjectConversationTurnToSteering = async (
        conversationId: string,
        token: string,
        actorReference: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectConversation(
            conversationId,
            token,
            ProjectPermission.ConversationTurnCreate,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, access.conversationId, signal);
        const execution = await this.cx.gateways.botSessions.promoteQueuedTurnToSteering(
            access.scope,
            conversation.sessionId,
            turnId,
            now,
            signal,
        );
        const runtimeAccess = await this.readRuntimeAccess(cx, access.scope, execution.runtimeId, signal);
        await this.cx.gateways.channels.dispatchPending(runtimeAccess, signal);
        return { disposition: "steer", turnId: execution.turnId };
    };

    private readonly readRuntimeAccess = async (
        cx: BotProjectStorageContext,
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ) => {
        const row = await cx.storages.control.readRuntime(scope, runtimeId, signal);
        if (row === null) {
            throw new BotApiError("binding_incompatible", "The selected Runtime is unavailable", "conflict");
        }
        return new VerifiedChannelAccess(row.channel_id, row.runtime_id, row.project_id);
    };

    private readonly authorizeConversation = async (
        cx: BotProjectStorageContext,
        access: BotConversationAuthorization,
        conversationId: string,
        signal: AbortSignal,
    ) => {
        const row = await cx.services.conversations.readConversation(conversationId, signal);
        if (row.bot_id !== access.botId || row.lifecycle !== "active") {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation is not accessible",
                "access-denied",
            );
        }
        if (access instanceof BotConnectionAccess && row.connection_id !== access.connectionId) {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation belongs to another connection",
                "access-denied",
            );
        }
        return {
            botId: row.bot_id,
            conversationId: row.conversation_id,
            sessionId: row.session_id,
            bindingId: row.binding_id,
            bindingRevision: row.binding_revision,
            creatorKind: row.creator_kind,
            connectionId: typeof row.connection_id === "string" ? row.connection_id : "",
        };
    };

    private readonly approvedTargets = async (
        cx: BotProjectStorageContext,
        botId: string,
        identifiers: readonly string[],
        signal: AbortSignal,
    ) => {
        const targets: BotDeliveryTargetReference[] = [];
        const unique = new Set<string>();
        for (const identifier of identifiers) {
            const targetId = validateIdentifier(identifier, "delivery_target_id");
            if (unique.has(targetId)) {
                throw new BotApiError("invalid_request", "Delivery targets must be unique", "invalid-input");
            }
            unique.add(targetId);
            const target = await cx.storages.control.readDeliveryTarget(targetId, signal);
            if (
                target === null ||
                target.bot_id !== botId ||
                target.lifecycle !== "active" ||
                target.connection_lifecycle !== "active" ||
                target.owner_approved !== 1
            ) {
                throw new BotApiError(
                    "delivery_target_not_allowed",
                    "The delivery target is not approved for this Bot",
                    "access-denied",
                );
            }
            targets.push(new BotDeliveryTargetReference(target.alias, target.delivery_target_id));
        }
        return targets;
    };

    private readonly readActiveBinding = async (
        cx: BotProjectStorageContext,
        botId: string,
        signal: AbortSignal,
    ): Promise<ActiveBindingContext> => {
        const binding = await cx.storages.control.readActiveBinding(botId, signal);
        if (binding === null) {
            const bot = await this.readLifecycle(cx, botId, signal);
            if (bot.lifecycle === "suspended") {
                throw new BotApiError("bot_suspended", "The Bot is suspended", "conflict");
            }
            throw new BotApiError("binding_not_active", "The Bot has no active binding", "conflict");
        }
        const behavior = await cx.storages.control.readBehavior(binding.bot_id, binding.behavior_revision_id, signal);
        if (behavior === null || behavior.lifecycle !== "active") {
            throw new BotApiError("behavior_not_active", "The Bot behavior is not active", "conflict");
        }
        const targets = await this.approvedTargets(
            cx,
            binding.bot_id,
            stringArray(binding.allowed_delivery_target_ids_json, "The binding targets are invalid"),
            signal,
        );
        const policy = completionPolicy(binding.completion_policy_json);
        const configuration = sessionConfigurations(behavior.agent_configuration_json);
        return {
            bindingId: binding.binding_id,
            bindingRevision: binding.binding_revision,
            botId: binding.bot_id,
            behaviorRevisionId: binding.behavior_revision_id,
            runtimeId: binding.runtime_id,
            agentRef: binding.agent_ref,
            workspaceRef: binding.workspace_ref,
            agentConfigRevision: binding.agent_config_revision,
            behaviorInstructions: behavior.instructions,
            behaviorDigest: behavior.content_digest,
            allowedDeliveryTargets: Object.freeze(targets),
            completionPolicy: policy,
            executionConfiguration: executionConfiguration(binding.execution_configuration_json),
            sessionConfigurations: configuration,
        };
    };

    private readonly readActiveConversationExecution = async (
        cx: BotProjectStorageContext,
        scope: ProjectScope,
        botId: string,
        signal: AbortSignal,
    ): Promise<{ readonly binding: ActiveBindingContext; readonly runtimeId: string }> => {
        const execution = await cx.storages.control.readActiveConversationExecution(scope, botId, signal);
        if (execution === null) {
            const binding = await this.readActiveBinding(cx, botId, signal);
            const runtime = await this.readRuntimeAccess(cx, scope, binding.runtimeId, signal);
            return { binding, runtimeId: runtime.runtimeId };
        }
        const targets = await this.approvedTargets(
            cx,
            execution.bot_id,
            stringArray(execution.allowed_delivery_target_ids_json, "The binding targets are invalid"),
            signal,
        );
        return {
            binding: {
                bindingId: execution.binding_id,
                bindingRevision: execution.binding_revision,
                botId: execution.bot_id,
                behaviorRevisionId: execution.behavior_revision_id,
                runtimeId: execution.runtime_id,
                agentRef: execution.agent_ref,
                workspaceRef: execution.workspace_ref,
                agentConfigRevision: execution.agent_config_revision,
                behaviorInstructions: execution.behavior_instructions,
                behaviorDigest: execution.behavior_content_digest,
                allowedDeliveryTargets: Object.freeze(targets),
                completionPolicy: completionPolicy(execution.completion_policy_json),
                executionConfiguration: executionConfiguration(execution.execution_configuration_json),
                sessionConfigurations: sessionConfigurations(execution.behavior_agent_configuration_json),
            },
            runtimeId: execution.paired_runtime_id,
        };
    };

    readonly createBot = async (
        projectId: string,
        token: string,
        actorReference: string,
        displayName: string,
        avatarRef: string,
        description: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProject(
            projectId,
            token,
            ProjectPermission.BotProfileWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const profile: BotProfileRevision = {
            botId: `bot_${access.scope.projectId}_${createRandomToken(18)}`,
            profileRevisionId: `bpr_${createRandomToken(18)}`,
            revisionNumber: 1,
            lifecycleRevision: 1,
            displayName,
            avatarRef,
            description,
            createdAt: new Date(now).toISOString(),
        };
        if (!(await cx.storages.control.writeBot(access, profile, now, signal))) {
            throw new BotApiError("bot_service_unavailable", "The Bot was not created", "unavailable");
        }
        return {
            ...new DraftBot(
                profile.botId,
                access.scope.projectId,
                profile.profileRevisionId,
                1,
                profile.createdAt,
                profile.createdAt,
            ),
            avatarRef,
            description,
            displayName,
            profileRevision: 1,
        };
    };
    readonly readBot = async (botId: string, token: string, actorReference: string, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        return botResource(await cx.storages.control.readBot(access, signal));
    };
    readonly readSetup = async (botId: string, token: string, actorReference: string, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotRead,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const { bot, behavior, binding } = await cx.storages.control.readSetup(access, signal);
        if (bot === null) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
        }
        const base = {
            lifecycle: bot.lifecycle,
            lifecycleRevision: bot.lifecycle_revision,
            behaviorRevision: behavior?.revision ?? 0,
        };
        if (binding === null) {
            return { ...base, configuration: { kind: "not-configured" } };
        }
        return {
            ...base,
            configuration: {
                kind: binding.lifecycle,
                runtimeId: binding.runtime_id,
                agentRef: binding.agent_ref,
                workspaceRef: binding.workspace_ref,
                instructions: binding.instructions,
                allowedDeliveryTargetIds: stringArray(
                    binding.allowed_delivery_target_ids_json,
                    "Invalid delivery targets",
                ),
                completionPolicy: completionPolicy(binding.completion_policy_json),
                executionConfiguration: executionConfiguration(binding.execution_configuration_json),
            },
        };
    };
    readonly createProfileRevision = async (
        botId: string,
        token: string,
        actorReference: string,
        revision: number,
        displayName: string,
        avatarRef: string,
        description: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotProfileWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const bot = await this.readLifecycle(cx, access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be changed", "conflict");
        }
        if (bot.revision !== revision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", "conflict");
        }
        const revisionNumber = (await cx.storages.control.readLatestProfileRevision(access.botId, signal)) + 1;
        const profile: BotProfileRevision = {
            avatarRef,
            botId: access.botId,
            createdAt: new Date(now).toISOString(),
            description,
            displayName,
            lifecycleRevision: revision + 1,
            profileRevisionId: `bpr_${createRandomToken(18)}`,
            revisionNumber,
        };
        if (!(await cx.storages.control.writeProfileRevision(access, revision, profile, now, signal))) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", "conflict");
        }
        return profile;
    };
    readonly createBehaviorRevision = async (
        botId: string,
        token: string,
        actorReference: string,
        revision: number,
        instructions: string,
        capabilities: readonly string[],
        configuration: Readonly<Record<string, unknown>>,
        now: number,
        signal: AbortSignal,
    ) => {
        if (capabilities.some((capability) => capability !== "embedded-context")) {
            throw new BotApiError("invalid_request", "The behavior capability is not supported", "invalid-input");
        }
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotBehaviorWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const bot = await this.readLifecycle(cx, access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be changed", "conflict");
        }
        if ((await cx.storages.control.readLatestBehaviorRevision(access.botId, signal)) !== revision) {
            throw new BotApiError("revision_conflict", "The Bot behavior revision changed", "conflict");
        }
        const behaviorRevisionId = `bbr_${createRandomToken(18)}`;
        const contentDigest = await hashSecret(
            JSON.stringify({
                agentConfiguration: configuration,
                instructions,
                requiredCapabilities: [...capabilities].sort(),
            }),
        );
        signal.throwIfAborted();
        const behavior: BotBehaviorRevision = {
            agentConfiguration: configuration,
            behaviorRevisionId,
            botId: access.botId,
            contentDigest,
            createdAt: new Date(now).toISOString(),
            instructions,
            lifecycle: "proposed",
            requiredCapabilities: capabilities,
            revisionNumber: revision + 1,
        };
        if (!(await cx.storages.control.writeBehaviorRevision(access, behavior, now, signal))) {
            throw new BotApiError("bot_service_unavailable", "The Bot behavior was not created", "unavailable");
        }
        return behavior;
    };
    readonly createExecutionBinding = async (
        botId: string,
        token: string,
        actorReference: string,
        revision: number,
        behaviorRevisionId: string,
        runtimeId: string,
        agentRef: string,
        workspaceRef: string,
        agentConfigRevision: number,
        requestedExecutionConfiguration: AgentExecutionConfiguration,
        targets: readonly string[],
        policy: BotCompletionDeliveryPolicy,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotBindingWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const bot = await this.readLifecycle(cx, access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "An archived Bot cannot be bound", "conflict");
        }
        if (bot.revision !== revision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", "conflict");
        }
        const behavior = await cx.storages.control.readBehavior(
            access.botId,
            validateIdentifier(behaviorRevisionId, "behavior_revision_id"),
            signal,
        );
        if (behavior === null || behavior.lifecycle !== "proposed") {
            throw new BotApiError("behavior_not_active", "The Bot behavior cannot be bound", "conflict");
        }
        const runtime = await cx.storages.control.readBindingRuntime(
            access.scope,
            validateIdentifier(runtimeId, "runtime_id"),
            signal,
        );
        if (runtime === null) {
            throw new BotApiError("binding_incompatible", "The requested Runtime is unavailable", "conflict");
        }
        const agent = parseAgents(runtime.agents_json).find((candidate) => candidate.id === agentRef);
        if (agent === undefined) {
            throw new BotApiError("binding_incompatible", "The requested Agent is unavailable", "conflict");
        }
        const configuration = sessionConfigurations(behavior.agent_configuration_json);
        if (agent.botSessionConfiguration !== true) {
            throw new BotApiError(
                "binding_incompatible",
                "Update the local Mobius CLI before configuring this Agent",
                "conflict",
            );
        }
        const requiredConfigurationIdentifiers = new Set([
            AGENT_PERMISSION_MODE_CONFIG_ID,
            requestedExecutionConfiguration.model.configId,
            requestedExecutionConfiguration.reasoningEffort.configId,
        ]);
        if (configuration.some((selection) => requiredConfigurationIdentifiers.has(selection.configId))) {
            throw new BotApiError(
                "invalid_request",
                "Behavior configuration cannot override required execution settings",
                "invalid-input",
            );
        }
        const requirements = stringArray(behavior.required_capabilities_json, "The behavior requirements are invalid");
        if (requirements.includes("embedded-context") && !agent.capabilities.embeddedContextPrompt) {
            throw new BotApiError(
                "binding_incompatible",
                "The Agent cannot apply the required Bot behavior",
                "conflict",
            );
        }
        await this.approvedTargets(cx, access.botId, targets, signal);
        if (policy instanceof RequiredBotCompletionDeliveryPolicy && !targets.includes(policy.deliveryTargetId)) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The completion target is not included in the binding",
                "access-denied",
            );
        }
        const bindingRevision = (await cx.storages.control.readLatestBindingRevision(access.botId, signal)) + 1;
        const bindingId = `beb_${createRandomToken(18)}`;
        const binding = {
            agentConfigRevision,
            agentRef,
            behaviorRevisionId: behavior.behavior_revision_id,
            bindingId,
            bindingRevision,
            completionPolicy: policy,
            executionConfiguration: requestedExecutionConfiguration,
            runtimeId: runtime.runtime_id,
            workspaceRef,
        };
        let written: boolean;
        try {
            written = await cx.storages.control.writeBinding(access, binding, targets, now, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotApiError("revision_conflict", "The Bot binding could not be activated", "conflict", {
                cause,
            });
        }
        if (!written) {
            throw new BotApiError("revision_conflict", "The Bot binding could not be activated", "conflict");
        }
        return {
            activatedAt: new Date(now).toISOString(),
            bindingId,
            bindingRevision,
            lifecycle: "active",
        };
    };
    readonly transitionBot = async (
        botId: string,
        token: string,
        actorReference: string,
        revision: number,
        action: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotProfileWrite,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const bot = await this.readLifecycle(cx, access.botId, signal);
        if (bot.revision !== revision) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", "conflict");
        }
        let lifecycle: "active" | "suspended" | "archived";
        if (action === "suspend") {
            if (bot.lifecycle !== "active") {
                throw new BotApiError("bot_not_active", "Only an active Bot can be suspended", "conflict");
            }
            lifecycle = "suspended";
        } else if (action === "resume") {
            if (
                bot.lifecycle !== "suspended" ||
                typeof bot.activeBehaviorRevisionId !== "string" ||
                typeof bot.activeBindingId !== "string"
            ) {
                throw new BotApiError("bot_not_active", "Only a suspended executable Bot can be resumed", "conflict");
            }
            lifecycle = "active";
        } else if (action === "archive") {
            if (bot.lifecycle === "archived") {
                throw new BotApiError("bot_not_active", "The Bot is already archived", "conflict");
            }
            lifecycle = "archived";
        } else {
            throw new BotApiError("invalid_request", "The Bot lifecycle action is invalid", "invalid-input");
        }
        if (!(await cx.storages.control.writeLifecycle(access, revision, lifecycle, now, signal))) {
            throw new BotApiError("revision_conflict", "The Bot revision changed", "conflict");
        }
        return botResource(await cx.storages.control.readBot(access, signal));
    };
    readonly createGrant = async (
        botId: string,
        token: string,
        actorReference: string,
        audience: string,
        label: string,
        scopes: readonly string[],
        expiresInSeconds: number,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotConnectionManage,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3_600) {
            throw new BotApiError("invalid_request", "The connection grant lifetime is invalid", "invalid-input");
        }
        const bot = await this.readLifecycle(cx, access.botId, signal);
        if (bot.lifecycle === "archived") {
            throw new BotApiError("bot_not_active", "The Bot cannot create a connection grant", "conflict");
        }
        const grantId = `bcg_${access.scope.projectId}_${createRandomToken(18)}`;
        const grantSecret = `${access.scope.projectId}_${createRandomToken(32)}`;
        const expiresAt = now + expiresInSeconds * 1_000;
        const secretDigest = await hashSecret(grantSecret);
        signal.throwIfAborted();
        if (
            !(await cx.storages.connections.writeGrant(
                access,
                { grantId, secretDigest, audience, label, scopes, expiresAt },
                now,
                signal,
            ))
        ) {
            throw new BotApiError("bot_service_unavailable", "The Bot connection grant was not created", "unavailable");
        }
        return {
            audience,
            botId: access.botId,
            expiresAt: new Date(expiresAt).toISOString(),
            grantId,
            grantSecret,
            label,
            scopes,
        };
    };

    readonly revokeConnectionForOwner = async (
        botId: string,
        token: string,
        actorReference: string,
        connectionId: string,
        expectedRevision: number,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotConnectionManage,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const normalizedConnectionId = validateIdentifier(connectionId, "connection_id");
        const connection = await cx.storages.connections.readProjectConnection(access, normalizedConnectionId, signal);
        if (connection === null) {
            throw new BotApiError("connection_not_found", "The Bot connection does not exist", "not-found");
        }
        if (
            connection.lifecycle !== "active" ||
            connection.lifecycle_revision !== expectedRevision ||
            !(await cx.storages.connections.writeOwnerRevocation(
                access,
                normalizedConnectionId,
                expectedRevision,
                now,
                signal,
            ))
        ) {
            throw new BotApiError("revision_conflict", "The Bot connection revision changed", "conflict");
        }
        return {
            botId: access.botId,
            connectionId: normalizedConnectionId,
            lifecycle: "revoked",
            lifecycleRevision: expectedRevision + 1,
            revokedAt: new Date(now).toISOString(),
        };
    };
    readonly redeemGrant = async (
        grantId: string,
        grantSecret: string,
        audience: string,
        connectorPrincipalId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        const normalizedGrantId = validateIdentifier(grantId, "grant_id");
        const grantDigest = await hashSecret(grantSecret);
        signal.throwIfAborted();
        const grant = await this.cx.services.authorization.authenticateGrant(
            normalizedGrantId,
            grantDigest,
            audience,
            now,
            signal,
        );
        const cx = await this.context(grant.project_id, signal);
        const connectionId = `bcn_${grant.project_id}_${createRandomToken(18)}`;
        const credentialId = `bcc_${createRandomToken(18)}`;
        const credential = `${grant.project_id}_${createRandomToken(32)}`;
        const credentialDigest = await hashSecret(credential);
        signal.throwIfAborted();
        const expiresAt = now + BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS;
        if (
            !(await cx.storages.connections.writeGrantRedemption(
                grant,
                {
                    grantId: normalizedGrantId,
                    grantDigest,
                    audience,
                    connectorPrincipalId,
                    connectionId,
                    credentialId,
                    credentialDigest,
                    expiresAt,
                },
                now,
                signal,
            ))
        ) {
            throw new BotApiError(
                "credential_invalid",
                "The Bot connection grant is invalid or consumed",
                "unauthenticated",
            );
        }
        return {
            audience: grant.audience,
            botId: grant.bot_id,
            connectionId,
            connectorPrincipalId,
            credential,
            credentialExpiresAt: new Date(expiresAt).toISOString(),
            credentialId,
            label: grant.label,
            lifecycle: "active",
            lifecycleRevision: 1,
            projectId: grant.project_id,
            scopes: stringArray(grant.scopes_json, "The Bot connection grant is invalid"),
        };
    };
    readonly approveTarget = async (
        botId: string,
        token: string,
        actorReference: string,
        targetId: string,
        revision: number,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeProjectBot(
            botId,
            token,
            ProjectPermission.BotConnectionManage,
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const deliveryTargetId = validateIdentifier(targetId, "delivery_target_id");
        if (
            !(await cx.storages.connections.writeTargetApproval(
                access,
                deliveryTargetId,
                revision,
                revision + 1,
                now,
                signal,
            ))
        ) {
            throw new BotApiError("revision_conflict", "The delivery target policy revision changed", "conflict");
        }
        const target = await cx.storages.connections.readTarget(deliveryTargetId, signal);
        if (target === null) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target does not exist", "not-found");
        }
        return {
            alias: target.alias,
            botId: target.bot_id,
            connectionId: target.connection_id,
            deliveryTargetId: target.delivery_target_id,
            lifecycle: target.lifecycle,
            lifecycleRevision: 1,
            outboundPolicyRevision: target.outbound_policy_revision,
            ownerApproved: true,
        };
    };

    readonly createConversation = async (
        botId: string,
        token: string,
        actorReference: string,
        request: NewBotConversation,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationCreate,
            "inbound-conversation:create",
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const binding = await this.readActiveBinding(cx, botId, signal);
        await this.readRuntimeAccess(cx, access.scope, binding.runtimeId, signal);
        const createPlan = async () => {
            if (access instanceof ProjectBotAccess && request.kind === "owner") {
                return cx.services.conversations.createProjectConversation(
                    access,
                    binding,
                    request.clientConversationKey,
                    now,
                    signal,
                );
            }
            if (access instanceof BotConnectionAccess && request.kind === "connection") {
                await cx.services.targets.authorizeConversationReplyTarget(
                    botId,
                    access.connectionId,
                    request.replyDeliveryTargetId,
                    signal,
                );
                return cx.services.conversations.createConnectedConversation(
                    access,
                    binding,
                    request.clientConversationKey,
                    request.title,
                    request.replyDeliveryTargetId,
                    now,
                    signal,
                );
            }
            throw new BotApiError(
                "invalid_request",
                "The conversation request does not match its access context",
                "invalid-input",
            );
        };
        const plan = await createPlan();
        await this.cx.gateways.botSessions.provisionConversation(
            access.scope,
            plan.provisioning,
            now,
            signal,
            unmeasuredOperationTiming,
        );
        return cx.services.conversations.activateConversation(
            access.scope,
            plan.provisioning.conversationId,
            now,
            signal,
        );
    };
    readonly submitMessage = async (
        botId: string,
        token: string,
        actorReference: string,
        conversationId: string,
        request: NewBotMessage,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationTurnCreate,
            "inbound-message:create",
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, conversationId, signal);
        let submission: BotTurnSubmission;
        if (access instanceof ProjectBotAccess && request.kind === "owner") {
            submission = new BotTurnSubmission(
                request.clientMessageId,
                request.actorRef,
                request.text,
                [],
                [],
                await this.cx.gateways.sessions.resolveArtifactResources(
                    access.scope,
                    conversation.sessionId,
                    request.artifactIds,
                    signal,
                ),
            );
        } else if (access instanceof BotConnectionAccess && request.kind === "connection") {
            submission = new BotTurnSubmission(
                request.clientMessageId,
                request.actorRef,
                request.text,
                [],
                [],
                request.resourceRefs.map((reference) => ({
                    mimeType: "",
                    name: reference,
                    text: "",
                    type: "link",
                    uri: `mobius://resource/${encodeURIComponent(reference)}`,
                })),
            );
        } else {
            throw new BotApiError(
                "invalid_request",
                "The Bot message does not match its access context",
                "invalid-input",
            );
        }
        return await this.acceptAuthorizedMessage(cx, access, conversation, submission, now, signal);
    };

    readonly submitConversationAccessMessage = async (
        access: ConversationAccessContext,
        clientMessageId: string,
        text: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.MessageCreate);
        return await this.runConversationAccessMessage(
            access,
            clientMessageId,
            text,
            additionalDirectoryIds,
            images,
            resources,
            artifactIds,
            now,
            signal,
        );
    };

    readonly runConversationAccessMessage = async (
        access: ConversationAccessContext,
        clientMessageId: string,
        text: string,
        additionalDirectoryIds: readonly string[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ) => {
        access.require(ConversationPermission.TurnCreate);
        if (artifactIds.length > 0) {
            access.require(ConversationPermission.ArtifactRead);
        }
        const cx = await this.projectContext(access.scope, signal);
        const row = await cx.services.conversations.readConversation(access.conversationId, signal);
        if (row.session_id !== access.sessionId || row.lifecycle !== "active") {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation is not accessible",
                "access-denied",
            );
        }
        const botAccess = new ConversationBotAccess(access, row.bot_id);
        const conversation = await this.authorizeConversation(cx, botAccess, access.conversationId, signal);
        const artifactResources = await this.cx.gateways.sessions.resolveArtifactResources(
            access.scope,
            access.sessionId,
            artifactIds,
            signal,
        );
        return await this.acceptAuthorizedMessage(
            cx,
            botAccess,
            conversation,
            new BotTurnSubmission(
                validateIdentifier(clientMessageId, "client_message_id"),
                access.actorReference,
                text,
                additionalDirectoryIds,
                images,
                [...resources, ...artifactResources],
            ),
            now,
            signal,
        );
    };

    private readonly acceptAuthorizedMessage = async (
        cx: BotProjectStorageContext,
        access: BotConversationAuthorization,
        conversation: AuthorizedBotConversation,
        submission: BotTurnSubmission,
        now: number,
        signal: AbortSignal,
    ) => {
        const bot = await cx.storages.conversations.readBotLifecycle(access, signal);
        if (bot?.lifecycle === "suspended") {
            throw new BotApiError("bot_suspended", "The Bot is suspended", "conflict");
        }
        if (bot?.lifecycle !== "active") {
            throw new BotApiError("bot_not_active", "The Bot is not active", "conflict");
        }
        const executionState = await cx.storages.conversations.readExecutionState(
            access,
            conversation.bindingId,
            conversation.bindingRevision,
            signal,
        );
        if (
            executionState === null ||
            executionState.binding_lifecycle !== "active" ||
            executionState.runtime_status !== "paired"
        ) {
            throw new BotApiError("binding_incompatible", "The conversation Runtime is unavailable", "conflict");
        }
        const accepted = await this.cx.gateways.botSessions.acceptTurn(
            access.scope,
            conversation.sessionId,
            submission,
            now,
            signal,
        );
        await cx.services.conversations.registerExecution(
            access.scope,
            accepted.execution,
            access instanceof BotConnectionAccess
                ? {
                      kind: "connection",
                  }
                : {
                      kind: "owner",
                      title: conversationTitleFromText(
                          submission.prompt.trim().length > 0
                              ? submission.prompt
                              : (submission.resources[0]?.name ?? "Attachment"),
                      ),
                  },
            now,
            signal,
        );
        const runtimeAccess = await this.readRuntimeAccess(cx, access.scope, accepted.execution.runtimeId, signal);
        await this.cx.gateways.channels.dispatchPending(runtimeAccess, signal);
        return {
            duplicate: accepted.duplicate,
            eventCursor: "",
            executionId: accepted.execution.executionId,
            turnId: accepted.execution.turnId,
        };
    };
    readonly readConversationEvents = async (
        botId: string,
        token: string,
        actorReference: string,
        conversationId: string,
        after: string,
        waitMilliseconds: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationRead,
            "conversation-events:read",
            actorReference,
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, conversationId, signal);
        const page = await this.cx.gateways.botSessions.readConversationEvents(
            access.scope,
            conversation.sessionId,
            after,
            BOT_CONVERSATION_EVENT_PAGE_LIMIT,
            waitMilliseconds,
            signal,
        );
        return access instanceof BotConnectionAccess ? connectorEventPage(page) : page;
    };
    readonly readConversationMessages = async (
        botId: string,
        token: string,
        actorReference: string,
        conversationId: string,
        cursor: string,
        limit: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationRead,
            "conversation-messages:read",
            actorReference,
            signal,
        );
        if (access instanceof BotConnectionAccess) {
            throw new BotApiError(
                "conversation_access_denied",
                "Bot connection credentials cannot read authoritative conversation history",
                "access-denied",
            );
        }
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, conversationId, signal);
        return await this.cx.gateways.botSessions.readConversationMessages(
            access.scope,
            conversation.sessionId,
            cursor,
            limit,
            signal,
        );
    };
    readonly readConversationToolCallDetail = async (
        botId: string,
        token: string,
        actorReference: string,
        conversationId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationRead,
            "conversation-messages:read",
            actorReference,
            signal,
        );
        if (access instanceof BotConnectionAccess) {
            throw new BotApiError(
                "conversation_access_denied",
                "Bot connection credentials cannot read authoritative conversation history",
                "access-denied",
            );
        }
        const cx = await this.projectContext(access.scope, signal);
        const conversation = await this.authorizeConversation(cx, access, conversationId, signal);
        return await this.cx.gateways.sessions.readToolCallDetail(
            access.scope,
            conversation.sessionId,
            attemptId,
            toolCallId,
            signal,
        );
    };
    readonly cancelTurn = async (
        botId: string,
        token: string,
        actorReference: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const authorization = await this.cx.services.authorization.authorizeInbound(
            botId,
            token,
            ProjectPermission.ConversationTurnCancel,
            "turn:cancel",
            actorReference,
            signal,
        );
        const cx = await this.projectContext(authorization.scope, signal);
        const turn = await cx.storages.conversations.readTurnConversation(
            authorization.botId,
            validateIdentifier(turnId, "turn_id"),
            signal,
        );
        if (turn === null) {
            throw new BotApiError("conversation_access_denied", "The Bot turn is not accessible", "access-denied");
        }
        const conversation = await this.authorizeConversation(cx, authorization, turn.conversation_id, signal);
        const runtimeId = await this.cx.gateways.sessions.readTurnRuntime(
            authorization.scope,
            conversation.sessionId,
            turnId,
            signal,
        );
        const runtimeAccess = await this.readRuntimeAccess(cx, authorization.scope, runtimeId, signal);
        const accepted = await this.cx.gateways.sessions.acceptTurnCancellation(
            authorization.scope,
            runtimeId,
            conversation.sessionId,
            turnId,
            idempotencyKey,
            now,
            signal,
        );
        await this.cx.gateways.channels.dispatchPending(runtimeAccess, signal);
        return { duplicate: accepted.duplicate, turnId: accepted.turn.turnId };
    };

    readonly rotateCredential = async (id: string, token: string, now: number, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeConnectorManagement(id, token, signal);
        const cx = await this.projectContext(access.scope, signal);
        const credentialId = `bcc_${createRandomToken(18)}`;
        const credential = createRandomToken(32);
        const expiresAt = now + BOT_CONNECTION_CREDENTIAL_LIFETIME_MILLISECONDS;
        const oldExpiresAt = now + BOT_CONNECTION_CREDENTIAL_OVERLAP_MILLISECONDS;
        const credentialDigest = await hashSecret(credential);
        signal.throwIfAborted();
        if (
            !(await cx.storages.connections.writeCredentialRotation(
                access,
                { credentialId, credentialDigest, expiresAt, oldExpiresAt },
                now,
                signal,
            ))
        ) {
            throw new BotApiError(
                "credential_invalid",
                "The Bot connection credential could not rotate",
                "unauthenticated",
            );
        }
        return {
            connectionId: access.connectionId,
            credential,
            credentialExpiresAt: new Date(expiresAt).toISOString(),
            credentialId,
            overlapEndsAt: new Date(oldExpiresAt).toISOString(),
        };
    };
    readonly revokeConnection = async (id: string, token: string, now: number, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeConnectorManagement(id, token, signal);
        const cx = await this.projectContext(access.scope, signal);
        if (!(await cx.storages.connections.writeConnectionRevocation(access, now, signal))) {
            throw new BotApiError("connection_revoked", "The Bot connection was already revoked", "unauthenticated");
        }
        return {
            botId: access.botId,
            connectionId: access.connectionId,
            lifecycle: "revoked",
            lifecycleRevision: 2,
            revokedAt: new Date(now).toISOString(),
        };
    };
    readonly createTarget = async (id: string, token: string, alias: string, now: number, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeConnectorManagement(id, token, signal);
        const cx = await this.projectContext(access.scope, signal);
        const deliveryTargetId = `bdt_${createRandomToken(18)}`;
        let written: boolean;
        try {
            written = await cx.storages.connections.writeTarget(access, deliveryTargetId, alias, now, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotApiError("revision_conflict", "The delivery target alias is already registered", "conflict", {
                cause,
            });
        }
        if (!written) {
            throw new BotApiError("revision_conflict", "The delivery target alias is already registered", "conflict");
        }
        return {
            alias,
            botId: access.botId,
            connectionId: access.connectionId,
            createdAt: new Date(now).toISOString(),
            deliveryTargetId,
            lifecycle: "active",
            lifecycleRevision: 1,
            outboundPolicyRevision: 0,
            ownerApproved: false,
        };
    };
    readonly disableTarget = async (id: string, token: string, targetId: string, now: number, signal: AbortSignal) => {
        const access = await this.cx.services.authorization.authorizeConnectorManagement(id, token, signal);
        const cx = await this.projectContext(access.scope, signal);
        const deliveryTargetId = validateIdentifier(targetId, "delivery_target_id");
        if (!(await cx.storages.connections.writeTargetDisabling(access, deliveryTargetId, now, signal))) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target is unavailable", "conflict");
        }
        return {
            connectionId: access.connectionId,
            deliveryTargetId,
            disabledAt: new Date(now).toISOString(),
            lifecycle: "disabled",
        };
    };
    readonly readOutbound = async (
        id: string,
        token: string,
        after: number,
        limit: number,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeConnector(
            id,
            token,
            "outbound-message:read",
            signal,
        );
        const cx = await this.projectContext(access.scope, signal);
        const targets = await cx.storages.connections.listActiveTargetIds(access.connectionId, signal);
        return this.cx.gateways.connections.read(id, after, limit, now, targets, signal);
    };
    readonly delivered = async (
        id: string,
        token: string,
        messageId: string,
        claimId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeConnector(
            id,
            token,
            "outbound-message:ack",
            signal,
        );
        return this.cx.gateways.connections.delivered(access.connectionId, messageId, claimId, now, signal);
    };
    readonly retryableFailure = async (
        id: string,
        token: string,
        messageId: string,
        claimId: string,
        code: string,
        retryAfterSeconds: number,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeConnector(
            id,
            token,
            "outbound-message:ack",
            signal,
        );
        if (retryAfterSeconds < 1 || retryAfterSeconds > 3_600) {
            throw new BotApiError("invalid_request", "The retry delay is invalid", "invalid-input");
        }
        return this.cx.gateways.connections.retryableFailure(
            access.connectionId,
            messageId,
            claimId,
            code,
            now + retryAfterSeconds * 1_000,
            now,
            signal,
        );
    };
    readonly terminalFailure = async (
        id: string,
        token: string,
        messageId: string,
        claimId: string,
        code: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const access = await this.cx.services.authorization.authorizeConnector(
            id,
            token,
            "outbound-message:ack",
            signal,
        );
        return this.cx.gateways.connections.terminalFailure(access.connectionId, messageId, claimId, code, now, signal);
    };

    readonly acceptOutbound = async (
        executionId: string,
        token: string,
        capability: string,
        target: { readonly kind: "reply" } | { readonly kind: "target"; readonly id: string },
        outbound: { readonly idempotencyKey: string; readonly text: string },
        now: number,
        signal: AbortSignal,
    ) => {
        const runtime = await this.cx.services.authorization.authorizeRuntimeExecution(executionId, token, signal);
        const cx = await this.projectContext(runtime.scope, signal);
        const permit = await this.cx.gateways.botSessions.authorizeExecutionCapability(
            runtime.scope,
            runtime.sessionId,
            runtime.executionId,
            capability,
            now,
            signal,
        );
        assertPinnedExecutionPermit(runtime, permit, now);
        const resolveTarget = async () => {
            if (target.kind === "target") {
                return target.id;
            }
            const reply = await cx.services.conversations.readReplyRoute(runtime.conversationId, signal);
            if (!(reply instanceof BotConnectionReplyRoute)) {
                throw new BotApiError(
                    "delivery_target_not_allowed",
                    "The Bot conversation has no external reply target",
                    "access-denied",
                );
            }
            return reply.deliveryTargetId;
        };
        const deliveryTargetId = await resolveTarget();
        if (!permit.allowedTargetIds.has(deliveryTargetId)) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The delivery target is not allowed for this Bot execution",
                "access-denied",
            );
        }
        const route = await cx.services.targets.authorizeOutboundTarget(
            runtime.botId,
            runtime.bindingId,
            deliveryTargetId,
            signal,
        );
        const accepted = await this.cx.gateways.botSessions.acceptOutbound(
            runtime.scope,
            runtime.sessionId,
            runtime.executionId,
            capability,
            new BotOutboundSubmission(outbound.idempotencyKey, route.deliveryTargetId, outbound.text),
            now,
            signal,
        );
        await cx.services.conversations.recordOutboundAccepted(runtime.scope, runtime.runtimeId, accepted, now, signal);
        try {
            await this.cx.gateways.connections.enqueue(route, accepted, signal);
            await this.cx.gateways.botSessions.markOutboundForwarded(
                runtime.scope,
                runtime.sessionId,
                accepted.outboundMessageId,
                now,
                signal,
            );
        } catch (error) {
            signal.throwIfAborted();
            console.error("Bot outbound forwarding will be reconciled", error);
        }
        return { duplicate: accepted.duplicate, outboundMessageId: accepted.outboundMessageId };
    };
}
