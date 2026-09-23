import { randomUUID } from "node:crypto";
import type { NativeSessionResult, SessionCancelCommand, SessionPromptCommand } from "@moxt-ai/mobius-protocol";
import { fetch } from "undici";
import type { DaemonConfig } from "./config.ts";
import { environmentProxyDispatcher } from "./network/environment-proxy.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "./relay-connection/runtime-authentication.ts";

const ACTIVE_TURN_RECONCILIATION_TIMEOUT_MILLISECONDS = 20_000;
const ACTIVE_TURN_TEXT_LIMIT = 100_000;
type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

export class ActiveDaemonTurn {
    readonly attemptId: string;
    readonly command: SessionPromptCommand;
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    #cancellationRequested = false;
    #accepted = false;
    #text = "";
    #truncated = false;
    #sequence = 0;
    readonly #epoch = randomUUID();

    constructor(command: SessionPromptCommand, attemptId: string) {
        this.attemptId = attemptId;
        this.command = command;
        this.#controller = new AbortController();
    }

    readonly abortDaemon = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => this.#finished.resolve();

    readonly accept = (): { readonly epoch: string; readonly sequence: 0 } => {
        this.#accepted = true;
        return { epoch: this.#epoch, sequence: 0 };
    };

    readonly recordText = (delta: string): { readonly epoch: string; readonly sequence: number } => {
        this.#sequence += 1;
        this.#text += delta;
        if (this.#text.length > ACTIVE_TURN_TEXT_LIMIT) {
            this.#text = this.#text.slice(-ACTIVE_TURN_TEXT_LIMIT);
            this.#truncated = true;
        }
        return { epoch: this.#epoch, sequence: this.#sequence };
    };

    readonly snapshot = (): ActiveTurnSnapshot =>
        this.#accepted
            ? {
                  commandId: this.command.commandId,
                  prompt: this.command.prompt,
                  text: this.#text,
                  truncated: this.#truncated,
                  epoch: this.#epoch,
                  sequence: this.#sequence,
                  state: "running",
              }
            : null;

    readonly matches = (cancellation: SessionCancelCommand): boolean =>
        cancellation.commandId === this.command.commandId && cancellation.sessionId === this.command.sessionId;

    readonly requestCancellation = (): boolean => {
        if (this.#cancellationRequested) {
            return false;
        }
        this.#cancellationRequested = true;
        return true;
    };

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}

export class ActiveTurnReconciliationError extends Error {
    readonly code = "active_turn_reconciliation_failed";
    readonly diagnosticDetails: Readonly<Record<string, string>>;
    readonly relayErrorCode: string | null;
    readonly terminal: boolean;

    constructor(
        message: string,
        options: ErrorOptions & { readonly relayErrorCode?: string | null; readonly terminal?: boolean } = {},
    ) {
        super(message, options);
        this.name = "ActiveTurnReconciliationError";
        this.relayErrorCode = options.relayErrorCode ?? null;
        this.terminal = options.terminal ?? false;
        this.diagnosticDetails = this.relayErrorCode === null ? {} : { relayErrorCode: this.relayErrorCode };
    }
}

/**
 * The Relay reports a reconciliation conflict when the Attempt is no longer owned by this Runtime or has
 * already reached a terminal state. Retrying cannot change that outcome, so the daemon must abandon the
 * stale turn instead of replacing its connection forever.
 */
const TERMINAL_RECONCILIATION_RELAY_CODES = new Set(["session_conflict"]);

async function relayErrorCode(response: Awaited<ReturnType<typeof fetch>>): Promise<string | null> {
    try {
        const body: unknown = JSON.parse(await response.text());
        if (typeof body !== "object" || body === null) {
            return null;
        }
        const error = Reflect.get(body, "error");
        if (typeof error !== "object" || error === null) {
            return null;
        }
        const code = Reflect.get(error, "code");
        return typeof code === "string" && code.length > 0 ? code : null;
    } catch {
        return null;
    }
}

function activeTurnReconciliationEndpoint(config: DaemonConfig, turn: ActiveDaemonTurn): URL {
    const endpoint = relayHttpEndpoint(config.relayUrl);
    let channelPath = "";
    if (endpoint.pathname.endsWith("/daemon")) {
        channelPath = endpoint.pathname.slice(0, -"/daemon".length);
    } else {
        const runtimePath = "/v1/runtimes/connect";
        if (!endpoint.pathname.endsWith(runtimePath)) {
            throw new ActiveTurnReconciliationError("The Relay URL is invalid");
        }
        channelPath = `${endpoint.pathname.slice(0, -runtimePath.length)}/channels/${encodeURIComponent(config.channelId)}`;
    }
    endpoint.pathname = `${channelPath}/sessions/${encodeURIComponent(turn.command.sessionId)}/attempts/${encodeURIComponent(turn.attemptId)}/reconciliation`;
    return endpoint;
}

async function reconcileActiveTurn(config: DaemonConfig, turn: ActiveDaemonTurn, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(ACTIVE_TURN_RECONCILIATION_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
        response = await fetch(activeTurnReconciliationEndpoint(config, turn), {
            body: JSON.stringify({ outcome: { kind: "running" } }),
            dispatcher: environmentProxyDispatcher,
            headers: { ...runtimeAuthorization(config.relayUrl), "content-type": "application/json" },
            method: "POST",
            signal: requestSignal,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        throw new ActiveTurnReconciliationError(
            timeoutSignal.aborted
                ? "The active Agent turn reconciliation timed out"
                : "The active Agent turn could not be reconciled",
            { cause: error },
        );
    }
    if (!response.ok) {
        const errorCode = await relayErrorCode(response);
        const terminal = errorCode !== null && TERMINAL_RECONCILIATION_RELAY_CODES.has(errorCode);
        throw new ActiveTurnReconciliationError(
            terminal
                ? `The Relay reported that the active Agent turn can no longer be reconciled (${errorCode})`
                : `The Relay rejected the active Agent turn reconciliation with status ${response.status.toString()}`,
            { relayErrorCode: errorCode, terminal },
        );
    }
    await response.body?.cancel();
}

export async function reconcileActiveTurns(
    config: DaemonConfig,
    turns: readonly ActiveDaemonTurn[],
    signal: AbortSignal,
): Promise<void> {
    await Promise.all(turns.map(async (turn) => await reconcileActiveTurn(config, turn, signal)));
}
