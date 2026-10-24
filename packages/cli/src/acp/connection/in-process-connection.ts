import { type AgentApp, type AnyMessage, type ClientConnection, methods } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "../acp-error.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";

/** Applies local processing backpressure; this does not acknowledge network delivery. */
export function connectInProcessAgent(
    app: AgentApp,
    handler: AcpClientHandler,
): { readonly connection: ClientConnection; readonly stopUpdates: () => void } {
    const requests = new TransformStream<AnyMessage, AnyMessage>();
    const updates = new TransformStream<AnyMessage, AnyMessage>();
    const writer = updates.writable.getWriter();
    let pending: ReturnType<typeof Promise.withResolvers<void>> | null = null;
    let disposal: Promise<void> | null = null;
    const stopUpdates = (): void => {
        pending?.reject(new AcpExecutionError("The in-process ACP connection closed", {}, "acp_endpoint_closed"));
    };
    const stop = (): void => {
        stopUpdates();
        const cause = new AcpExecutionError("The in-process ACP connection closed", {}, "acp_endpoint_closed");
        if (disposal === null) {
            // Aborting an already failed writer may reject; either outcome releases
            // our lock. The delivery and SDK connection own the operation's error.
            disposal = writer.abort(cause).then(
                () => writer.releaseLock(),
                () => writer.releaseLock(),
            );
        }
    };
    const connection = createAcpClient({
        onPermission: handler.onPermission,
        onElicitation: handler.onElicitation,
        onElicitationComplete: handler.onElicitationComplete,
        onUpdate: async (notification) => {
            const delivery = pending;
            try {
                await handler.onUpdate(notification);
                delivery?.resolve();
            } catch (cause) {
                delivery?.reject(cause);
                throw cause;
            }
        },
    }).connect({ readable: updates.readable, writable: requests.writable });
    try {
        const peer = app.connect({
            readable: requests.readable,
            writable: new WritableStream<AnyMessage>({
                async write(message) {
                    // The SDK's default memory transport only waits for a read, not
                    // the notification handler. Hold the producer's write until
                    // session output is processed, while leaving RPC handling concurrent.
                    const delivery =
                        "method" in message && message.method === methods.client.session.update && !("id" in message)
                            ? Promise.withResolvers<void>()
                            : null;
                    pending = delivery;
                    try {
                        // Observe teardown rejection even if the transport write fails first.
                        if (delivery !== null) {
                            await Promise.all([writer.write(message), delivery.promise]);
                        } else {
                            await writer.write(message);
                        }
                    } finally {
                        pending = null;
                    }
                },
                close: async () => await writer.close(),
                abort: async (cause) => await writer.abort(cause),
            }),
        });
        void connection.closed.then(() => {
            stop();
            peer.close();
        });
        void peer.closed.then(() => {
            stop();
            connection.close();
        });
        return { connection, stopUpdates };
    } catch (cause) {
        stop();
        connection.close();
        throw cause;
    }
}
