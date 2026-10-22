import { AGENT_SETTINGS_DISCOVERY_FAILED_KIND, type AgentSettingsDiscoverCommand } from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import {
    AcpConfigurationValueUnavailableError,
    AcpExecutionError,
    type AgentRuntimeManager,
} from "../../session/manager/session-manager.ts";
import { discoverAgentSettings } from "../../session/settings/discover-agent-settings.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import { agentSettingsFailureDetails, send } from "./transport.ts";

interface SettingsDiscoveryDependencies {
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export function createAgentSettingsDiscoveryHandler(dependencies: SettingsDiscoveryDependencies) {
    const { config, directories, sessions, diagnostics, socket, signal, timer } = dependencies;
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
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, {
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
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, {
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "Another settings discovery is already running for this Agent",
                    requestId: command.requestId,
                });
            }
            return;
        }
        if (agentSettingsDiscoveries.size >= 4) {
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, {
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
                    new AcpExecutionError("Agent settings discovery timed out", {}, "agent_settings_discovery_timeout"),
                ),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                const result = await discoverAgentSettings(command, config, directories, sessions, operationSignal);
                for (const diagnostic of result.unsupportedModels) {
                    const details = agentSettingsFailureDetails(command.agentId, diagnostic);
                    diagnostics.daemonDiagnostic("agent_settings_model_unsupported", command.requestId, details);
                    process.stderr.write(
                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_model_unsupported", requestId: command.requestId, ...details })}\n`,
                    );
                }
                for (const requestId of requestIds) {
                    if (socket.readyState === WebSocket.OPEN) {
                        send(socket, { ...result.event, requestId });
                    }
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new AcpExecutionError(
                          "Agent settings discovery cancelled",
                          {},
                          "agent_settings_discovery_cancelled",
                      ))
                    : error;
                const details = agentSettingsFailureDetails(command.agentId, failure);
                diagnostics.daemonDiagnostic("agent_settings_discovery_failed", command.requestId, details, failure);
                if (failure instanceof AcpConfigurationValueUnavailableError) {
                    process.stderr.write(
                        `Mobius daemon diagnostic ${JSON.stringify({ event: "agent_settings_discovery_failed", requestId: command.requestId, ...details })}\n`,
                    );
                }
                if (socket.readyState === WebSocket.OPEN) {
                    for (const requestId of requestIds) {
                        send(socket, {
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
