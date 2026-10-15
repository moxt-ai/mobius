import type { DaemonToServiceMessage } from "@moxt-ai/mobius-protocol";
export interface RuntimeManagement {
    readonly connected: (runtimeId: string, projectId: string, signal: AbortSignal) => Promise<void>;
    readonly message: (
        runtimeId: string,
        projectId: string,
        message: DaemonToServiceMessage,
        signal: AbortSignal,
    ) => Promise<boolean>;
}
