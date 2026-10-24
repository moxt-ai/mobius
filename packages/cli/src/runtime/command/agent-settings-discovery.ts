import { AGENT_SETTINGS_DISCOVERY_FAILED_KIND, type AgentSettingsDiscoverCommand } from "@moxt-ai/mobius-sdk/protocol";
import { OperationError, operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import { SessionError } from "../../session/api/session-error.ts";
import type { SessionManager } from "../../session/manager/session-manager.ts";
import { agentSettingsFailureDetails, discoverAgentSettings } from "../../session/settings/discover-agent-settings.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import { resolveCatalogAgent } from "../catalog/resolve-catalog-agent.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { RuntimeCommandTransport } from "./transport.ts";
import { send } from "./transport.ts";

interface SettingsDiscoveryDependencies {
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly transport: RuntimeCommandTransport;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export function createAgentSettingsDiscoveryHandler(dependencies: SettingsDiscoveryDependencies) {
    const { config, directories, sessions, diagnostics, transport, signal, timer } = dependencies;
    const agentSettingsDiscoveries = new Map<
        string,
        {
            readonly agentId: string;
            readonly model: string | undefined;
            readonly requestIds: Set<string>;
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const handle = (command: AgentSettingsDiscoverCommand): void => {
        const existing = [...agentSettingsDiscoveries.values()].find(
            (request) => request.agentId === command.agentId && !request.controller.signal.aborted,
        );
        if ([...agentSettingsDiscoveries.values()].some((request) => request.requestIds.has(command.requestId))) {
            if (transport.isOpen()) {
                send(transport, {
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "This settings discovery request is already running",
                    requestId: command.requestId,
                });
            }
            return;
        }
        if (existing !== undefined && existing.model === command.model && existing.requestIds.size < 16) {
            existing.requestIds.add(command.requestId);
            return;
        }
        if (existing !== undefined) {
            if (transport.isOpen()) {
                send(transport, {
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "Another settings discovery is already running for this Agent",
                    requestId: command.requestId,
                });
            }
            return;
        }
        if (agentSettingsDiscoveries.size >= 4) {
            if (transport.isOpen()) {
                send(transport, {
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "Too many Agent settings discoveries are running",
                    requestId: command.requestId,
                });
            }
            return;
        }
        const controller = new AbortController();
        const requestIds = new Set([command.requestId]);
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () =>
                controller.abort(
                    new SessionError("agent_settings_discovery_timeout", "Agent settings discovery timed out"),
                ),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                const result = await discoverAgentSettings(
                    command,
                    (agentId, agentSignal) => resolveCatalogAgent(config, agentId, agentSignal),
                    config.bindingId,
                    directories,
                    sessions,
                    operationSignal,
                );
                for (const diagnostic of result.unsupportedModels) {
                    const details = agentSettingsFailureDetails(command.agentId, diagnostic);
                    diagnostics.daemonDiagnostic("agent_settings_model_unsupported", command.requestId, details);
                    process.stderr.write(
                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_model_unsupported", requestId: command.requestId, ...details })}\n`,
                    );
                }
                for (const requestId of requestIds) {
                    if (transport.isOpen()) {
                        send(transport, { ...result.event, requestId });
                    }
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new SessionError("agent_settings_discovery_cancelled", "Agent settings discovery cancelled"))
                    : error;
                const details = agentSettingsFailureDetails(command.agentId, failure);
                diagnostics.daemonDiagnostic("agent_settings_discovery_failed", command.requestId, details, failure);
                if (failure instanceof OperationError && failure.code === "invalid_session_configuration") {
                    process.stderr.write(
                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_discovery_failed", requestId: command.requestId, ...details })}\n`,
                    );
                }
                if (transport.isOpen()) {
                    for (const requestId of requestIds) {
                        send(transport, {
                            code: operationErrorCode(failure),
                            kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                            message: operationErrorMessage(failure),
                            requestId,
                        });
                    }
                }
            } finally {
                timeout.cancel();
                agentSettingsDiscoveries.delete(command.requestId);
            }
        })();
        agentSettingsDiscoveries.set(command.requestId, {
            agentId: command.agentId,
            model: command.model,
            requestIds,
            completion,
            controller,
        });
        return;
    };
    const settle = async (): Promise<void> => {
        await Promise.all([...agentSettingsDiscoveries.values()].map((request) => request.completion));
    };
    return { handle, settle };
}
