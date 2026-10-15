import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type LifecycleResponse, lifecycleCommand, lifecycleResponse } from "../../daemon-lifecycle-protocol.ts";

export const workerManagerCommand = lifecycleCommand.refine(
    (command) => command.kind === "switch" || command.kind === "switch-status",
);
export const workerManagerRequest = z.object({
    kind: z.literal("manager-request"),
    requestId: z.string().uuid(),
    command: workerManagerCommand,
});
const managerReply = z.object({
    kind: z.literal("manager-response"),
    requestId: z.string().uuid(),
    response: lifecycleResponse,
});

export class ManagerIpcError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
    }
}

export async function requestParentManager(
    command: z.infer<typeof workerManagerCommand>,
    signal: AbortSignal,
): Promise<LifecycleResponse> {
    signal.throwIfAborted();
    if (!process.connected || process.send === undefined) {
        throw new ManagerIpcError("manager_disconnected", "The worker has no manager IPC channel");
    }
    const request = workerManagerRequest.parse({ kind: "manager-request", requestId: randomUUID(), command });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
    return await new Promise<LifecycleResponse>((resolve, reject) => {
        const cleanup = (): void => {
            process.off("message", receive);
            process.off("disconnect", disconnected);
            deadline.removeEventListener("abort", aborted);
        };
        const fail = (cause: unknown): void => {
            cleanup();
            reject(cause);
        };
        const disconnected = (): void =>
            fail(new ManagerIpcError("manager_disconnected", "The manager IPC channel closed"));
        const aborted = (): void =>
            fail(
                signal.aborted
                    ? signal.reason
                    : new ManagerIpcError("manager_timeout", "The manager IPC request timed out"),
            );
        const receive = (raw: unknown): void => {
            const reply = managerReply.safeParse(raw);
            if (!reply.success || reply.data.requestId !== request.requestId) {
                return;
            }
            cleanup();
            resolve(reply.data.response);
        };
        process.on("message", receive);
        process.once("disconnect", disconnected);
        deadline.addEventListener("abort", aborted, { once: true });
        process.send?.(request, (cause) => {
            if (cause) {
                fail(new ManagerIpcError("manager_send_failed", "Could not send manager IPC request", { cause }));
            }
        });
    });
}
