import { z } from "zod";
import { AcpExecutionError } from "../acp-error.ts";
import type { AdapterSessionOpened, AdapterSessionScope } from "../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../protocol/native-session.ts";
import type { AcpExecutionConnection } from "./execution-connections.ts";

export function sessionWorkspace(scope: AdapterSessionScope) {
    return { cwd: scope.cwd, additionalDirectories: [...scope.additionalDirectories], mcpServers: [] };
}

export function createdNativeSessionId(response: unknown): string {
    const decoded = z.object({ sessionId: nativeSessionIdSchema }).safeParse(response);
    if (!decoded.success) {
        throw new AcpExecutionError(
            "The Agent returned an invalid native session",
            { cause: decoded.error },
            "invalid_native_session_response",
        );
    }
    return decoded.data.sessionId;
}

export async function normalizeOpenedSession(
    session: AcpExecutionConnection,
    nativeSessionId: string,
    response: unknown,
    signal: AbortSignal,
): Promise<AdapterSessionOpened> {
    await session.connection.race(
        session.connection.events.drained(),
        "ACP agent exited while opening a session",
        signal,
    );
    signal.throwIfAborted();
    const initialized = await session.connection.initializeAgent(signal);
    return {
        nativeSessionId,
        agentName: initialized.agentName,
        agentVersion: initialized.agentVersion,
        agentSettingsModelEffort: session.connection.agentSettingsModelEffort(),
        ...session.connection.commitLifecycle(response),
    };
}
