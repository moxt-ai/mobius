import { isAbsolute, resolve } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { decodeAgentPromptResponse, type SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import { arraysEqual, isRecord, truncate } from "../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../acp-error.ts";
import { buildPromptContent, type PromptContent } from "../client/prompt-content.ts";
import type { AcpContentExternalizer } from "../content/content-externalizer.ts";
import type { AdapterSessionTarget } from "../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../protocol/native-session.ts";
import {
    SessionConfigProtocolError,
    type SessionConfigurationSelection,
    sessionConfigProtocolForAgent,
} from "../protocol/session-config-protocol.ts";
import { AdapterSessionConnection, type LiveSessionConnectionOptions } from "./session-events.ts";

interface LiveSession {
    readonly connection: AdapterSessionConnection;
    readonly scope: LiveSessionConnectionOptions;
}

const absolutePathSchema = z.string().min(1).refine(isAbsolute);
const targetSchema = z.object({
    nativeSessionId: nativeSessionIdSchema,
    cwd: absolutePathSchema,
    additionalDirectories: z.array(absolutePathSchema),
});

/** Adapter-private active writers. Query sessions never enter this registry. */
export class AcpLiveSessions {
    readonly #sessions = new Set<LiveSession>();
    readonly #externalizer: Pick<AcpContentExternalizer, "update">;
    readonly #normalizeEvent: (event: unknown) => unknown;

    constructor(
        externalizer: Pick<AcpContentExternalizer, "update">,
        normalizeEvent: (event: unknown) => unknown = (event) => event,
    ) {
        this.#externalizer = externalizer;
        this.#normalizeEvent = normalizeEvent;
    }

    readonly connectSession = (scope: LiveSessionConnectionOptions): AdapterSessionConnection => {
        const connection = new AdapterSessionConnection(scope, this.#externalizer, this.#normalizeEvent, () =>
            this.#sessions.delete(session),
        );
        const session = { connection, scope };
        this.#sessions.add(session);
        return connection;
    };

    readonly #resolve = (target: AdapterSessionTarget): LiveSession => {
        const decoded = targetSchema.safeParse(target);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The native session target is invalid",
                { cause: decoded.error },
                "invalid_agent_session",
            );
        }
        const matches = [...this.#sessions].filter(
            ({ connection, scope }) =>
                connection.events.sessionId() === decoded.data.nativeSessionId &&
                scope.cwd === decoded.data.cwd &&
                scope.cwd === resolve(decoded.data.cwd) &&
                arraysEqual(scope.additionalDirectories, decoded.data.additionalDirectories) &&
                arraysEqual(
                    scope.additionalDirectories,
                    decoded.data.additionalDirectories.map((path) => resolve(path)),
                ),
        );
        if (matches.length > 1) {
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        const session = matches[0];
        if (session === undefined) {
            throw new AcpExecutionError("The native session is not active", {}, "invalid_agent_session");
        }
        return session;
    };

    readonly prompt = async (target: AdapterSessionTarget, content: PromptContent, signal: AbortSignal) => {
        signal.throwIfAborted();
        const { connection, scope } = this.#resolve(target);
        const prompt = buildPromptContent(content, scope.capabilities());
        const response: unknown = await connection.race(
            connection.connection.agent.request(
                methods.agent.session.prompt,
                { prompt, sessionId: target.nativeSessionId },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during a prompt",
            signal,
        );
        await connection.events.drained();
        try {
            return decodeAgentPromptResponse(response);
        } catch (cause) {
            throw new AcpExecutionError(
                "ACP agent returned an invalid prompt response",
                { cause },
                "acp_invalid_prompt_response",
            );
        }
    };

    readonly steer = async (
        target: AdapterSessionTarget,
        content: PromptContent,
        signal: AbortSignal,
    ): Promise<"injected" | "startedNewTurn"> => {
        signal.throwIfAborted();
        const { connection, scope } = this.#resolve(target);
        if (!scope.capabilities().steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        const response: unknown = await connection.race(
            connection.connection.agent.request(
                "_session/steering",
                {
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                    prompt: buildPromptContent(content, scope.capabilities()),
                    sessionId: target.nativeSessionId,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during steering",
            signal,
        );
        if (isRecord(response)) {
            const outcome = response["outcome"];
            if (outcome === "injected" || outcome === "startedNewTurn") {
                return outcome;
            }
            if (outcome === "promptRequired") {
                throw new AcpExecutionError(
                    "The target turn finished before steering could be injected",
                    {},
                    "steering_target_unavailable",
                );
            }
            if (outcome === "failed") {
                throw new AcpExecutionError("The Agent could not inject steering", {}, "steering_failed");
            }
        }
        throw new AcpExecutionError(
            "ACP agent returned an invalid steering response",
            {},
            "acp_invalid_steering_response",
        );
    };

    readonly renameSession = async (
        target: AdapterSessionTarget,
        title: string,
        signal: AbortSignal,
    ): Promise<{ readonly nativeRenameApplied: boolean }> => {
        signal.throwIfAborted();
        const { connection, scope } = this.#resolve(target);
        const normalized = truncate(title, 500);
        if (normalized.length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        if (!scope.capabilities().renameSession) {
            return { nativeRenameApplied: false };
        }
        try {
            await connection.race(
                connection.connection.agent.request(
                    "_session/rename",
                    { sessionId: target.nativeSessionId, title: normalized },
                    { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                ),
                "ACP agent exited while renaming the Session",
                signal,
            );
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError(
                "The Agent could not rename the Session",
                { cause: error },
                "session_rename_failed",
            );
        }
        return { nativeRenameApplied: true };
    };

    readonly configureSession = async (
        target: AdapterSessionTarget,
        selection: SessionConfigurationSelection,
        signal: AbortSignal,
    ): Promise<readonly SessionConfigOption[]> => {
        signal.throwIfAborted();
        const { connection, scope } = this.#resolve(target);
        const current = scope.configOptions();
        const existing = current.find((option) => option.id === selection.configId);
        if (
            existing === undefined ||
            existing.type !== selection.type ||
            (existing.type === "select" && existing.values.length < 2)
        ) {
            throw new AcpExecutionError(
                "The requested ACP configuration option is unavailable",
                {},
                "invalid_session_configuration",
            );
        }
        if (
            existing.type === "select" &&
            selection.type === "select" &&
            !existing.values.some((entry) => entry.value === selection.value)
        ) {
            throw new AcpConfigurationValueUnavailableError(
                selection.configId,
                selection.value,
                existing.values.map((entry) => entry.value),
            );
        }
        try {
            const configured = await sessionConfigProtocolForAgent(scope.agent.id).configure(
                current,
                {
                    booleanValue: selection.type === "boolean" ? selection.booleanValue : false,
                    configId: selection.configId,
                    signal,
                    value: selection.type === "select" ? selection.value : "",
                },
                target.nativeSessionId,
                {
                    request: async (method, params, failureMessage, signal) =>
                        await connection.race(
                            connection.connection.agent.request(method, params, { cancellationSignal: signal }),
                            failureMessage,
                            signal,
                        ),
                },
            );
            const applied = configured.find((option) => option.id === selection.configId);
            if (
                applied === undefined ||
                applied.type !== selection.type ||
                (applied.type === "boolean" &&
                    selection.type === "boolean" &&
                    applied.booleanValue !== selection.booleanValue) ||
                (applied.type === "select" && selection.type === "select" && applied.currentValue !== selection.value)
            ) {
                throw new AcpExecutionError(
                    "The Agent did not apply the requested session configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            await connection.events.drained();
            return configured;
        } catch (error) {
            if (error instanceof SessionConfigProtocolError) {
                throw new AcpExecutionError(error.message, { cause: error }, error.code);
            }
            throw error;
        }
    };

    readonly close = async (): Promise<void> => {
        const results = await Promise.allSettled(
            [...this.#sessions].map(({ connection }) => connection.closeProcess()),
        );
        for (const result of results) {
            if (result.status === "rejected") {
                throw result.reason;
            }
        }
    };
}
