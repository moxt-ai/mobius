import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { arraysEqual } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionId } from "../protocol/native-session.ts";

export interface ClientScope {
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
}

export interface ClientTargetParams {
    readonly nativeSessionId: NativeSessionId;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
    readonly signal: AbortSignal;
}

const absolutePath = z
    .string()
    .min(1)
    .refine((path) => isAbsolute(path) && path === resolve(path));
const scopeSchema = z.object({ cwd: absolutePath, additionalDirectories: z.array(absolutePath).readonly() }).readonly();

export function clientScope(scope: unknown): ClientScope {
    const decoded = scopeSchema.safeParse(scope);
    if (!decoded.success) {
        throw new AcpExecutionError(
            "The Pi client scope is invalid",
            { cause: decoded.error },
            "invalid_agent_session",
        );
    }
    return decoded.data;
}

export function assertClientScope(scope: ClientScope, target: ClientScope): void {
    const decoded = clientScope(target);
    if (scope.cwd !== decoded.cwd || !arraysEqual(scope.additionalDirectories, decoded.additionalDirectories)) {
        throw new AcpExecutionError("The native session workspace cannot change", {}, "session_identity_mismatch");
    }
}
