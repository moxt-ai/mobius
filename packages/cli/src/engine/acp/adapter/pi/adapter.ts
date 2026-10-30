import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { decodeAgentPromptResponse, type SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { truncate } from "../../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { buildPromptContent } from "../../client/prompt-content.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type {
    Adapter,
    AdapterDependencies,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionOpenParams,
    AdapterSessionTarget,
} from "../../native-history/preview-contract.ts";
import { NativeHistoryPreviewSnapshots } from "../../native-history/preview-snapshots.ts";
import { type NativeSessionId, nativeSessionIdSchema, nativeSessionPageSchema } from "../../protocol/native-session.ts";
import { normalizeAcpCapabilities } from "../../protocol/session-capabilities.ts";
import { normalizeConfigOptions } from "../../protocol/session-config-protocol.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { nativeSessionPreviewKey, nativeSessionQueryKey } from "../query-scope.ts";
import { piClientCallbacks, piPreviewCallbacks, piSessionCallbacks } from "./client-callbacks.ts";
import { createPiCatalogClient, createPiClient, type PiClientRuntime, piRuntime } from "./create-client.ts";
import { PiSession, type PiWorkspace } from "./pi-session.ts";

const START_TIMEOUT_MILLISECONDS = 60_000;

/** The fields of Pi's new/fork/resume/load responses that describe the opened session. */
interface PiSessionResponse {
    readonly configOptions?: Parameters<typeof normalizeConfigOptions>[0];
    readonly modes?: Parameters<typeof normalizeConfigOptions>[1];
}

function workspaceOf(target: { readonly cwd: string; readonly additionalDirectories: readonly string[] }): PiWorkspace {
    return { cwd: target.cwd, additionalDirectories: target.additionalDirectories };
}

/** Live Pi operations call the Pi harness directly; each native session owns one Pi client. */
export class PiAdapter implements Adapter {
    readonly #dependencies: AdapterDependencies;
    readonly #sessions = new Map<NativeSessionId, PiSession>();
    readonly #lifetime = new AbortController();
    readonly #previews = new NativeHistoryPreviewSnapshots();
    #agent: AcpAgentDefinition;
    #runtime: PiClientRuntime;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#agent = agent;
        this.#runtime = piRuntime(agent);
        this.#dependencies = dependencies;
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
        this.#runtime = piRuntime(agent);
    };

    /** Pi answers `initialize` from its configuration without launching a process. */
    readonly getCapabilities: Adapter["getCapabilities"] = async (query) => {
        query.signal.throwIfAborted();
        return await this.#capabilities(this.#catalog());
    };

    readonly createSession: Adapter["createSession"] = (params) =>
        this.#start(params, (agent) => agent.newSession({ cwd: params.scope.cwd, mcpServers: [] }));

    readonly forkSession: Adapter["forkSession"] = (params) => {
        const source = nativeSessionIdSchema.parse(params.sourceNativeSessionId);
        return this.#start(params, async (agent) => {
            const response = await agent.forkSession({ cwd: params.scope.cwd, sessionId: source, mcpServers: [] });
            if (response.sessionId === source) {
                throw new AcpExecutionError(
                    "Pi did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            return response;
        });
    };

    readonly openSession: Adapter["openSession"] = (params) => this.#open(params, "resume");

    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (params) => this.#open(params, "replay");

    readonly #open = async (params: AdapterSessionOpenParams, mode: "resume" | "replay") => {
        const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
        const request = { cwd: params.scope.cwd, sessionId: nativeSessionId, mcpServers: [] };
        const existing = this.#sessions.get(nativeSessionId);
        existing?.assertWorkspace(workspaceOf(params.scope));
        if (existing?.available === true && mode === "resume") {
            try {
                const response = await waitForAgentOperation(existing.agent.resumeSession(request), params.signal);
                return await this.#opened(existing, params, response);
            } catch (cause) {
                await this.#release(nativeSessionId);
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            }
        }
        // Pi replays history by restarting its process, so replay (or an unavailable client) starts a new one.
        await this.#release(nativeSessionId);
        return await this.#start(params, async (agent) => ({
            ...(mode === "resume" ? await agent.resumeSession(request) : await agent.loadSession(request)),
            sessionId: nativeSessionId,
        }));
    };

    readonly #start = async (
        params: AdapterSessionCreateParams,
        start: (agent: PiAcpAgent) => Promise<PiSessionResponse & { readonly sessionId: string }>,
    ): Promise<AdapterSessionOpened> => {
        const { session, response } = await PiSession.start(
            {
                runtime: this.#runtime,
                workspace: workspaceOf(params.scope),
                callbacks: piSessionCallbacks(params, params.scope.externalizeUpdate),
                externalizer: this.#dependencies.contentExternalizer,
                signal: AbortSignal.any([
                    params.signal,
                    this.#lifetime.signal,
                    AbortSignal.timeout(START_TIMEOUT_MILLISECONDS),
                ]),
            },
            start,
        );
        if (this.#lifetime.signal.aborted || this.#sessions.has(session.nativeSessionId)) {
            await session.dispose();
            this.#lifetime.signal.throwIfAborted();
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        this.#sessions.set(session.nativeSessionId, session);
        try {
            return await this.#opened(session, params, response);
        } catch (cause) {
            await this.#release(session.nativeSessionId);
            throw cause;
        }
    };

    readonly #opened = async (
        session: PiSession,
        params: AdapterSessionCreateParams,
        response: PiSessionResponse,
    ): Promise<AdapterSessionOpened> => {
        const initialized = await session.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
        return {
            nativeSessionId: session.nativeSessionId,
            capabilities: normalizeAcpCapabilities(initialized),
            configOptions: normalizeConfigOptions(response.configOptions, response.modes),
            agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? "pi", 255),
            agentVersion: params.scope.agent.agentVersion,
            agentSettingsModelEffort: null,
        };
    };

    readonly #session = (target: AdapterSessionTarget): PiSession => {
        this.#lifetime.signal.throwIfAborted();
        const session = this.#sessions.get(nativeSessionIdSchema.parse(target.nativeSessionId));
        if (session === undefined) {
            throw new AcpExecutionError("The native session is not active", {}, "invalid_agent_session");
        }
        session.assertWorkspace(workspaceOf(target));
        if (!session.available) {
            throw new AcpExecutionError("The Pi session is unavailable", {}, "session_busy");
        }
        return session;
    };

    readonly prompt: Adapter["prompt"] = async (params) => {
        const session = this.#session(params);
        const capabilities = await this.#capabilities(session.agent);
        const response = await session.prompt(
            { prompt: buildPromptContent(params.content, capabilities) },
            params.signal,
        );
        const decoded = decodeAgentPromptResponse(response);
        return {
            stopReason: decoded.stopReason,
            ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
            ...(decoded._meta === undefined ? {} : { _meta: decoded._meta }),
        };
    };

    readonly steer: Adapter["steer"] = async (params) => {
        const session = this.#session(params);
        const capabilities = await this.#capabilities(session.agent);
        const response = await session.agent
            .steer(
                {
                    sessionId: session.nativeSessionId,
                    prompt: buildPromptContent(params.content, capabilities),
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
        const session = this.#session(params);
        const outcome = await session.cancel(params.signal);
        if (outcome === "closed") {
            await this.#release(session.nativeSessionId);
        }
        return outcome;
    };

    readonly releaseSession: Adapter["releaseSession"] = async (params) => {
        const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
        const session = this.#sessions.get(nativeSessionId);
        session?.assertWorkspace(workspaceOf(params));
        await this.#release(nativeSessionId);
        params.signal.throwIfAborted();
    };

    readonly closeSession: Adapter["closeSession"] = this.releaseSession;

    /** Pi records its native history in a session file, so the revision is read without its process. */
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = async (params) => {
        const session = this.#session(params);
        const revision = await waitForAgentOperation(
            session.agent.readSessionRevision({ sessionId: session.nativeSessionId }),
            AbortSignal.any([params.signal, AbortSignal.timeout(30_000)]),
        );
        if (revision.latestEntryId.length > 256) {
            throw new AcpExecutionError(
                "Pi returned an invalid native history revision",
                {},
                "invalid_native_session_response",
            );
        }
        return { kind: "tracked", latestEntryId: revision.latestEntryId };
    };

    readonly #release = async (nativeSessionId: NativeSessionId): Promise<void> => {
        const session = this.#sessions.get(nativeSessionId);
        if (session !== undefined) {
            this.#sessions.delete(nativeSessionId);
            await session.dispose();
        }
    };

    readonly renameSession: Adapter["renameSession"] = async (params) => {
        this.#session(params);
        if (truncate(params.title, 500).length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        return { nativeRenameApplied: false };
    };

    /** A cancelled caller stops waiting; the session and its native configuration stay intact. */
    readonly configureSession: Adapter["configureSession"] = async (params) => {
        const session = this.#session(params);
        const { nativeSessionId, agent } = session;
        const selection = params.selection;
        const configure = async (): Promise<readonly SessionConfigOption[]> => {
            const configuration = await agent.sessionConfiguration(nativeSessionId);
            const option = normalizeConfigOptions(configuration.configOptions, configuration.modes).find(
                (option) => option.id === selection.configId,
            );
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
                await agent.setSessionMode({ sessionId: nativeSessionId, modeId: selection.value });
            } else {
                await agent.setSessionConfigOption({
                    sessionId: nativeSessionId,
                    configId: selection.configId,
                    value: selection.value,
                });
            }
            const applied = await agent.sessionConfiguration(nativeSessionId);
            const configOptions = normalizeConfigOptions(applied.configOptions, applied.modes);
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
        };
        return await waitForAgentOperation(configure(), params.signal);
    };

    /** Pi lists sessions from its session files without launching a process. */
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) => {
        query.signal.throwIfAborted();
        const result = await this.#catalog().listSessions({ ...(cursor === null ? {} : { cursor }) });
        query.signal.throwIfAborted();
        const decoded = nativeSessionPageSchema.safeParse(result);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "Pi returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

    readonly findSession: Adapter["findSession"] = ({ query, nativeSessionId, budget }) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);

    /** Pi replays a saved session only by loading it, so previews run one transient Pi client. */
    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({ query, request }) => {
        const scoped = {
            ...query,
            agent: this.#agent,
            signal: AbortSignal.any([
                query.signal,
                this.#lifetime.signal,
                AbortSignal.timeout(START_TIMEOUT_MILLISECONDS),
            ]),
        };
        scoped.signal.throwIfAborted();
        const nativeSessionId = nativeSessionIdSchema.parse(request.nativeSessionId);
        const key = nativeSessionPreviewKey(nativeSessionQueryKey(scoped), nativeSessionId);
        if (request.cursor !== null) {
            return this.#previews.get(key).page(nativeSessionId, request.eventLimit, request.cursor);
        }
        const store = this.#previews.replace(key);
        const runtime = this.#runtime;
        try {
            return await this.#dependencies.processes.runTransient(
                scoped.signal,
                async () => {
                    const lifetime = new AbortController();
                    const callbacks = piPreviewCallbacks(scoped, async (receivedNativeSessionId, event) => {
                        if (receivedNativeSessionId !== nativeSessionId) {
                            throw new AcpExecutionError(
                                "Pi replayed another native session",
                                {},
                                "invalid_agent_session",
                            );
                        }
                        store.append(nativeSessionId, { type: "acp", payload: event.payload });
                    });
                    const client = await createPiClient(
                        runtime,
                        piClientCallbacks(callbacks, this.#dependencies.contentExternalizer, {
                            signal: lifetime.signal,
                            fail: (cause) => lifetime.abort(cause),
                        }),
                        scoped.signal,
                    );
                    return {
                        client,
                        lifetime,
                        closeProcess: async () => {
                            lifetime.abort();
                            await client.dispose();
                        },
                    };
                },
                async ({ client, lifetime }) => {
                    await waitForAgentOperation(
                        client.loadSession({ cwd: scoped.cwd, sessionId: nativeSessionId, mcpServers: [] }),
                        scoped.signal,
                    );
                    lifetime.signal.throwIfAborted();
                    return store.page(nativeSessionId, request.eventLimit, null);
                },
                (runtime) => runtime.closeProcess(),
            );
        } catch (cause) {
            this.#previews.discard(key, store);
            throw agentOperationError(cause);
        }
    };

    readonly close = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Pi adapter closed", "AbortError"));
        const sessions = [...this.#sessions.keys()];
        await runCleanup(...sessions.map((nativeSessionId) => () => this.#release(nativeSessionId)), () =>
            this.#previews.close(),
        );
    };

    readonly #catalog = (): PiAcpAgent =>
        createPiCatalogClient(this.#runtime, {
            sessionUpdate: async () => undefined,
            startUserMessage: () => undefined,
            requestPermission: rejectCatalogInteraction,
            requestElicitation: rejectCatalogInteraction,
        });

    readonly #capabilities = async (agent: PiAcpAgent) =>
        normalizeAcpCapabilities(await agent.initialize({ protocolVersion: PROTOCOL_VERSION }));
}

async function rejectCatalogInteraction(): Promise<never> {
    throw new AcpExecutionError("Pi catalog queries cannot request user interaction", {}, "invalid_agent_session");
}
