import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { decodeAgentPromptResponse, type SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { truncate } from "../../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { buildPromptContent } from "../../client/prompt-content.ts";
import { agentOperationError } from "../../connection/agent-operation.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type {
    Adapter,
    AdapterDependencies,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionOpenParams,
} from "../../native-history/preview-contract.ts";
import { NativeHistoryPreviewSnapshots } from "../../native-history/preview-snapshots.ts";
import { nativeSessionIdSchema, nativeSessionPageSchema } from "../../protocol/native-session.ts";
import { normalizeAcpCapabilities } from "../../protocol/session-capabilities.ts";
import { normalizeConfigOptions } from "../../protocol/session-config-protocol.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { nativeSessionPreviewKey, nativeSessionQueryKey } from "../query-scope.ts";
import { piQueryClientParams, piSessionClientParams } from "./client-callbacks.ts";
import { PiClientManager } from "./client-manager.ts";

function piRuntime(agent: AcpAgentDefinition) {
    return { command: agent.command, environment: agent.environment, runtimeExecutables: agent.runtimeExecutables };
}

/** Live Pi operations use the existing native agent directly, not local ACP RPC. */
export class PiAdapter implements Adapter {
    readonly #clientManager: PiClientManager;
    readonly #dependencies: AdapterDependencies;
    #agent: AcpAgentDefinition;
    readonly #lifetime = new AbortController();
    readonly #previews = new NativeHistoryPreviewSnapshots();

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#clientManager = new PiClientManager(piRuntime(agent), dependencies.processes);
        this.#agent = agent;
        this.#dependencies = dependencies;
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#clientManager.refreshRuntime(piRuntime(agent));
        this.#agent = agent;
    };

    readonly getCapabilities: Adapter["getCapabilities"] = async (query) => {
        const scoped = {
            ...query,
            agent: this.#agent,
            signal: AbortSignal.any([query.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        const client = await this.#clientManager.obtainClientForQuery(
            piQueryClientParams(scoped, this.#dependencies.contentExternalizer),
        );
        try {
            return await this.#capabilities(client);
        } finally {
            this.#clientManager.releaseQueryClient(client);
        }
    };

    readonly #capabilities = async (client: PiAcpAgent) =>
        normalizeAcpCapabilities(await client.initialize({ protocolVersion: PROTOCOL_VERSION }));

    readonly #opened = async (
        client: PiAcpAgent,
        params: AdapterSessionCreateParams,
        nativeSessionId: string,
    ): Promise<AdapterSessionOpened> => {
        const initialized = await client.initialize({ protocolVersion: PROTOCOL_VERSION });
        const configuration = await client.sessionConfiguration(nativeSessionId, params.signal);
        return {
            nativeSessionId: nativeSessionIdSchema.parse(nativeSessionId),
            capabilities: normalizeAcpCapabilities(initialized),
            configOptions: normalizeConfigOptions(configuration.configOptions, configuration.modes),
            agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? "pi", 255),
            agentVersion: params.scope.agent.agentVersion,
            agentSettingsModelEffort: null,
        };
    };

    readonly createSession: Adapter["createSession"] = async (input) => {
        const params = {
            ...input,
            signal: AbortSignal.any([input.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        const client = await this.#clientManager.obtainClientForCreate(
            piSessionClientParams(params, this.#dependencies.contentExternalizer),
        );
        try {
            const response = await client.newSession({ cwd: params.scope.cwd, mcpServers: [] }, params.signal);
            const opened = await this.#opened(client, params, response.sessionId);
            this.#clientManager.adoptClient({
                client,
                nativeSessionId: nativeSessionIdSchema.parse(opened.nativeSessionId),
                signal: params.signal,
            });
            return opened;
        } catch (cause) {
            await client.dispose();
            throw agentOperationError(cause);
        }
    };

    readonly forkSession: Adapter["forkSession"] = async (input) => {
        const params = {
            ...input,
            signal: AbortSignal.any([input.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        const sourceNativeSessionId = nativeSessionIdSchema.parse(params.sourceNativeSessionId);
        const client = await this.#clientManager.obtainClientForCreate(
            piSessionClientParams(params, this.#dependencies.contentExternalizer),
        );
        try {
            const response = await client.forkSession(
                { cwd: params.scope.cwd, sessionId: sourceNativeSessionId, mcpServers: [] },
                params.signal,
            );
            const nativeSessionId = nativeSessionIdSchema.parse(response.sessionId);
            if (nativeSessionId === sourceNativeSessionId) {
                throw new AcpExecutionError(
                    "Pi did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            const opened = await this.#opened(client, params, nativeSessionId);
            this.#clientManager.adoptClient({ client, nativeSessionId, signal: params.signal });
            return opened;
        } catch (cause) {
            await client.dispose();
            throw agentOperationError(cause);
        }
    };

    readonly openSession: Adapter["openSession"] = (input) => this.#openSession(input, "resume");

    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (input) => this.#openSession(input, "replay");

    readonly #openSession = async (
        input: AdapterSessionOpenParams,
        mode: "resume" | "replay",
    ): Promise<AdapterSessionOpened> => {
        const params = {
            ...input,
            nativeSessionId: nativeSessionIdSchema.parse(input.nativeSessionId),
            signal: AbortSignal.any([input.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        const target = { ...params.scope, nativeSessionId: params.nativeSessionId, signal: params.signal };
        const reservation = this.#clientManager.reserveSession(target);
        try {
            const client =
                reservation.kind === "existing"
                    ? await this.#clientManager.obtainClientForOpen(target)
                    : await this.#clientManager.obtainClientForCreate(
                          piSessionClientParams(params, this.#dependencies.contentExternalizer),
                      );
            try {
                const request = { cwd: params.scope.cwd, sessionId: params.nativeSessionId, mcpServers: [] };
                if (mode === "resume") {
                    await client.resumeSession(request, params.signal);
                } else {
                    await client.loadSession(request, params.signal);
                }
                const opened = await this.#opened(client, params, params.nativeSessionId);
                if (reservation.kind === "new") {
                    this.#clientManager.adoptClient({
                        client,
                        nativeSessionId: params.nativeSessionId,
                        signal: params.signal,
                        reservation,
                    });
                }
                return opened;
            } catch (cause) {
                if (reservation.kind === "new") {
                    await client.dispose();
                } else {
                    await this.#clientManager.release({ ...target, signal: new AbortController().signal });
                }
                throw agentOperationError(cause);
            }
        } finally {
            this.#clientManager.releaseReservation(reservation);
        }
    };

    readonly prompt: Adapter["prompt"] = async (params) => {
        const client = await this.#clientManager.obtainClientForOpen({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
        const response = await client
            .prompt(
                {
                    sessionId: params.nativeSessionId,
                    prompt: buildPromptContent(params.content, await this.#capabilities(client)),
                },
                params.signal,
            )
            .catch((cause: unknown) => {
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            });
        const decoded = decodeAgentPromptResponse(response);
        return {
            stopReason: decoded.stopReason,
            ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
            ...(decoded._meta === undefined ? {} : { _meta: decoded._meta }),
        };
    };

    readonly steer: Adapter["steer"] = async (params) => {
        const client = await this.#clientManager.obtainClientForOpen({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
        const response = await client
            .steer(
                {
                    sessionId: params.nativeSessionId,
                    prompt: buildPromptContent(params.content, await this.#capabilities(client)),
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                },
                params.signal,
            )
            .catch((cause: unknown) => {
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            });
        if (response.outcome === "promptRequired") {
            throw new AcpExecutionError(
                "The target turn finished before steering could be injected",
                {},
                "steering_target_unavailable",
            );
        }
        return response;
    };

    readonly cancel: Adapter["cancel"] = async (params) => {
        params.signal.throwIfAborted();
        const client = await this.#clientManager.obtainClientForOpen({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
        await client.cancel({ sessionId: params.nativeSessionId });
        return "retained";
    };
    readonly releaseSession: Adapter["releaseSession"] = (params) =>
        this.#clientManager.release({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
    readonly closeSession: Adapter["closeSession"] = this.releaseSession;

    readonly renameSession: Adapter["renameSession"] = async (params) => {
        await this.#clientManager.obtainClientForOpen({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
        if (truncate(params.title, 500).length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        return { nativeRenameApplied: false };
    };

    readonly configureSession: Adapter["configureSession"] = async (params) => {
        const client = await this.#clientManager.obtainClientForOpen({
            ...params,
            nativeSessionId: nativeSessionIdSchema.parse(params.nativeSessionId),
        });
        try {
            const configuration = await client.sessionConfiguration(params.nativeSessionId, params.signal);
            const current = normalizeConfigOptions(configuration.configOptions, configuration.modes);
            const selection = params.selection;
            const option = current.find((option) => option.id === selection.configId);
            if (
                option === undefined ||
                option.type !== "select" ||
                selection.type !== "select" ||
                option.values.length < 2
            ) {
                throw new AcpExecutionError(
                    "The requested configuration option is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            if (!option.values.some((entry) => entry.value === selection.value)) {
                throw new AcpConfigurationValueUnavailableError(
                    selection.configId,
                    selection.value,
                    option.values.map((entry) => entry.value),
                );
            }
            if (option.category === "mode") {
                await client.setSessionMode(
                    { sessionId: params.nativeSessionId, modeId: selection.value },
                    params.signal,
                );
            } else {
                await client.setSessionConfigOption(
                    { sessionId: params.nativeSessionId, configId: selection.configId, value: selection.value },
                    params.signal,
                );
            }
            const applied = await client.sessionConfiguration(params.nativeSessionId, params.signal);
            const configOptions: readonly SessionConfigOption[] = normalizeConfigOptions(
                applied.configOptions,
                applied.modes,
            );
            if (
                !configOptions.some(
                    (option) => option.id === selection.configId && option.currentValue === selection.value,
                )
            ) {
                throw new AcpExecutionError(
                    "Pi did not apply the requested configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            return configOptions;
        } catch (cause) {
            params.signal.throwIfAborted();
            throw agentOperationError(cause);
        }
    };

    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) => {
        const scoped = {
            ...query,
            agent: this.#agent,
            signal: AbortSignal.any([query.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        const client = await this.#clientManager.obtainClientForQuery(
            piQueryClientParams(scoped, this.#dependencies.contentExternalizer),
        );
        try {
            scoped.signal.throwIfAborted();
            const result = await client.listSessions({ ...(cursor === null ? {} : { cursor }) });
            scoped.signal.throwIfAborted();
            const decoded = nativeSessionPageSchema.safeParse(result);
            if (!decoded.success) {
                throw new AcpExecutionError(
                    "Pi returned an invalid native session list",
                    { cause: decoded.error },
                    "invalid_native_session_response",
                );
            }
            return decoded.data;
        } finally {
            this.#clientManager.releaseQueryClient(client);
        }
    };
    readonly findSession: Adapter["findSession"] = ({ query, nativeSessionId, budget }) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({ query, request }) => {
        const scoped = {
            ...query,
            agent: this.#agent,
            signal: AbortSignal.any([query.signal, this.#lifetime.signal, AbortSignal.timeout(60_000)]),
        };
        scoped.signal.throwIfAborted();
        const nativeSessionId = nativeSessionIdSchema.parse(request.nativeSessionId);
        const key = nativeSessionPreviewKey(nativeSessionQueryKey(scoped), nativeSessionId);
        if (request.cursor !== null) {
            return this.#previews.get(key).page(nativeSessionId, request.eventLimit, request.cursor);
        }
        const store = this.#previews.replace(key);
        try {
            return await this.#dependencies.processes.runTransient(
                scoped.signal,
                () =>
                    this.#clientManager.obtainClientForCreate(
                        piQueryClientParams(
                            scoped,
                            this.#dependencies.contentExternalizer,
                            async (receivedNativeSessionId, event) => {
                                if (receivedNativeSessionId !== nativeSessionId) {
                                    throw new AcpExecutionError(
                                        "Pi replayed another native session",
                                        {},
                                        "invalid_agent_session",
                                    );
                                }
                                store.append(nativeSessionId, { type: "acp", payload: event.payload });
                            },
                        ),
                    ),
                async (client) => {
                    await client.loadSession(
                        { cwd: scoped.cwd, sessionId: nativeSessionId, mcpServers: [] },
                        scoped.signal,
                    );
                    return store.page(nativeSessionId, request.eventLimit, null);
                },
                (client) => client.dispose(),
            );
        } catch (cause) {
            this.#previews.discard(key, store);
            throw agentOperationError(cause);
        }
    };

    readonly close = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Pi adapter closed", "AbortError"));
        await runCleanup(
            () => this.#clientManager.close(),
            () => this.#previews.close(),
        );
    };
}
