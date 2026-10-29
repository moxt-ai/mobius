import { describeEnvironmentProxyRoute } from "../../util/network/environment-proxy.ts";
import type { RuntimeDiagnosticLog } from "../observability/diagnostic-log.ts";

const MAX_DIAGNOSTIC_TEXT_LENGTH = 256;

function sanitizeDiagnosticText(value: string): string {
    const printable = Array.from(value, (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
    }).join("");
    const withoutSecrets = printable
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [redacted]")
        .replace(/([?&](?:access_token|authorization|credential|key|secret|token)=)[^&\s]*/giu, "$1[redacted]")
        .replace(/(?:https?|wss?):\/\/[^\s)]+/giu, (encodedUrl) => {
            try {
                return new URL(encodedUrl).origin;
            } catch {
                return "[redacted-url]";
            }
        });
    return withoutSecrets.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function addFailureDetails(details: Record<string, string>, failure: unknown): void {
    let current = failure;
    for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
        const prefix = depth === 0 ? "failure" : `cause${depth.toString()}`;
        details[`${prefix}Name`] = sanitizeDiagnosticText(current.name);
        details[`${prefix}Message`] = sanitizeDiagnosticText(current.message);
        const code = Reflect.get(current, "code");
        if (typeof code === "string" || typeof code === "number") {
            details[`${prefix}Code`] = sanitizeDiagnosticText(String(code));
        }
        const statusCode = Reflect.get(current, "statusCode");
        if (typeof statusCode === "string" || typeof statusCode === "number") {
            details[`${prefix}StatusCode`] = sanitizeDiagnosticText(String(statusCode));
        }
        for (const field of ["syscall", "errno", "address", "port"]) {
            const value: unknown = Reflect.get(current, field);
            if (typeof value === "string" || typeof value === "number") {
                const key = depth === 0 ? field : `${prefix}${field.slice(0, 1).toUpperCase()}${field.slice(1)}`;
                details[key] = sanitizeDiagnosticText(String(value));
            }
        }
        const diagnosticDetails = Reflect.get(current, "diagnosticDetails");
        if (typeof diagnosticDetails === "object" && diagnosticDetails !== null) {
            for (const [key, value] of Object.entries(diagnosticDetails)) {
                if (typeof value === "string") {
                    details[key] = sanitizeDiagnosticText(value);
                }
            }
        }
        current = current.cause;
    }
}

export function describeRelayFailure(failure: unknown): Readonly<Record<string, string>> {
    const details: Record<string, string> = {};
    addFailureDetails(details, failure);
    return details;
}

export class RelayConnectionDiagnostics {
    #lastSkippedLogAt = Number.NEGATIVE_INFINITY;
    #skippedCount = 0;
    readonly #channelId: string;
    readonly #localLog: RuntimeDiagnosticLog;
    #lastClosedEpoch = 0;
    #lastFailedEpoch = 0;
    readonly #relayOrigin: string;
    readonly #route: Readonly<Record<string, string>>;

    constructor(channelId: string, relayUrl: URL, localLog: RuntimeDiagnosticLog) {
        this.#channelId = channelId;
        this.#localLog = localLog;
        this.#relayOrigin = relayUrl.origin;
        this.#route = describeEnvironmentProxyRoute(relayUrl);
    }

    readonly snapshot = () => this.#localLog.snapshot();

    readonly catalogFailed = (failure: unknown): void => {
        const details: Record<string, string> = { ...this.#route, relayOrigin: this.#relayOrigin };
        addFailureDetails(details, failure);
        this.#record("agent_catalog_publish_failed", details, true);
    };

    readonly connectionClosed = (connectionEpoch: number, code: number, reason: string, source: string): void => {
        if (this.#lastClosedEpoch === connectionEpoch) {
            return;
        }
        this.#lastClosedEpoch = connectionEpoch;
        this.#record(
            "relay_connection_closed",
            {
                closeCode: code.toString(),
                closeReason: sanitizeDiagnosticText(reason),
                connectionEpoch: connectionEpoch.toString(),
                relayOrigin: this.#relayOrigin,
                source,
                ...this.#route,
            },
            true,
        );
    };

    readonly connectionFailed = (connectionEpoch: number, failure: unknown, source: string): void => {
        if (this.#lastFailedEpoch === connectionEpoch) {
            return;
        }
        this.#lastFailedEpoch = connectionEpoch;
        const details: Record<string, string> = {
            connectionEpoch: connectionEpoch.toString(),
            relayOrigin: this.#relayOrigin,
            source,
            ...this.#route,
        };
        addFailureDetails(details, failure);
        this.#record("relay_connection_failed", details, true);
    };

    readonly transportFailed = (connectionEpoch: number, failure: Error, source: string): void => {
        const details: Record<string, string> = {
            connectionEpoch: connectionEpoch.toString(),
            relayOrigin: this.#relayOrigin,
            source,
            ...this.#route,
        };
        addFailureDetails(details, failure);
        this.#record("relay_transport_failed", details, true);
    };

    readonly connectionOpened = (connectionEpoch: number): void => {
        this.#record(
            "relay_connection_opened",
            {
                connectionEpoch: connectionEpoch.toString(),
                relayOrigin: this.#relayOrigin,
                ...this.#route,
            },
            false,
        );
    };

    readonly heartbeatTimedOut = (connectionEpoch: number, timeoutMilliseconds: number): void => {
        this.#record(
            "relay_heartbeat_timed_out",
            {
                connectionEpoch: connectionEpoch.toString(),
                relayOrigin: this.#relayOrigin,
                timeoutMilliseconds: timeoutMilliseconds.toString(),
                ...this.#route,
            },
            true,
        );
    };

    readonly daemonDiagnostic = (
        event: string,
        requestId: string,
        details: Readonly<Record<string, string>>,
        failure?: unknown,
    ): void => {
        if (
            event === "protocol_message_discarded" ||
            event === "content_frame_discarded" ||
            event === "content_chunk_discarded" ||
            event === "prompt_attachments_skipped"
        ) {
            this.#skippedCount += 1;
            const now = Date.now();
            if (now - this.#lastSkippedLogAt < 60_000) {
                return;
            }
            details = { ...details, skippedCount: this.#skippedCount.toString() };
            this.#lastSkippedLogAt = now;
            this.#skippedCount = 0;
        }
        const recordedDetails: Record<string, string> = { ...details };
        if (failure !== undefined) {
            addFailureDetails(recordedDetails, failure);
        }
        this.#localLog.record(
            `Mobius daemon diagnostic ${JSON.stringify({
                timestamp: new Date().toISOString(),
                channelId: this.#channelId,
                event,
                requestId,
                ...recordedDetails,
            })}`,
        );
    };

    readonly #record = (event: string, details: Readonly<Record<string, string>>, warning: boolean): void => {
        const encoded = JSON.stringify({
            timestamp: new Date().toISOString(),
            channelId: this.#channelId,
            event,
            ...details,
        });
        this.#localLog.record(`Mobius relay diagnostic ${encoded}`);
        if (warning) {
            process.stderr.write(`Mobius relay diagnostic ${encoded}\n`);
            return;
        }
        process.stdout.write(`Mobius relay diagnostic ${encoded}\n`);
    };
}
