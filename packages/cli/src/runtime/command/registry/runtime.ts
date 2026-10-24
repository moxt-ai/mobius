import { RUNTIME_PING_KIND, RUNTIME_PONG_KIND } from "@moxt-ai/mobius-sdk/protocol";
import packageMetadata from "../../../../package.json" with { type: "json" };
import type { RuntimeCommand } from "../definition.ts";
import { send } from "../transport.ts";

export const runtimeDiagnosticsCommand: RuntimeCommand = {
    kind: "runtime.diagnostics.read",
    handle: ({ diagnostics, transport }, message): void => {
        if (message.kind !== "runtime.diagnostics.read") {
            throw new Error("Command kind mismatch");
        }
        try {
            send(transport, {
                kind: "runtime.diagnostics.result",
                requestId: message.requestId,
                version: packageMetadata.version,
                ...diagnostics.snapshot(),
            });
        } catch {
            send(transport, {
                kind: "session.operation.failed",
                requestId: message.requestId,
                sessionId: "runtime",
                code: "diagnostics_unavailable",
                message: "Local diagnostics are unavailable.",
            });
        }
    },
};

export const runtimePingCommand: RuntimeCommand = {
    kind: RUNTIME_PING_KIND,
    handle: ({ transport }, message): void => {
        if (message.kind !== RUNTIME_PING_KIND) {
            throw new Error("Command kind mismatch");
        }
        send(transport, { kind: RUNTIME_PONG_KIND, requestId: message.requestId });
    },
};
