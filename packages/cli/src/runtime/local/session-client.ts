import { createConnection } from "node:net";
import {
    type DaemonToServiceMessage,
    decodeDaemonToServiceMessage,
    decodeSessionsQueriedEvent,
    encodeServiceToDaemonMessage,
    type ServiceToDaemonMessage,
    type SessionMetadata,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import { validateControlSocket } from "../../storage/daemon/control-socket.ts";
import { readOrCreateControlToken } from "../../storage/daemon/control-token.ts";
import {
    LocalSessionError,
    localSessionSocketPath,
    readLocalSessionMessages,
    writeLocalSessionMessage,
} from "./session-stream.ts";

const attachedSchema = z.object({
    kind: z.literal("local.session.attached"),
    bindingId: z.string(),
    session: z.unknown(),
});
const errorSchema = z.object({ kind: z.literal("local.session.error"), code: z.string(), message: z.string() });

export interface LocalSessionConnection extends AsyncDisposable {
    readonly session: SessionMetadata;
    readonly bindingId: string;
    readonly messages: AsyncIterable<DaemonToServiceMessage>;
    readonly send: (command: ServiceToDaemonMessage) => void;
    readonly close: () => void;
}

export async function connectLocalSession(
    options: { readonly stateDirectory: string; readonly channelId: string; readonly sessionId: string },
    signal: AbortSignal,
): Promise<LocalSessionConnection> {
    signal.throwIfAborted();
    const path = localSessionSocketPath(options.stateDirectory, options.channelId);
    try {
        await validateControlSocket(path, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new LocalSessionError(
            "local_session_unavailable",
            "Start the Mobius daemon and check that its terminal socket is private and owned by your user",
            { cause },
        );
    }
    const token = await readOrCreateControlToken(options.stateDirectory);
    const socket = createConnection(path);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = (): void => {
        clearInterval(heartbeat);
        socket.destroy();
    };
    socket.setTimeout(10_000, () =>
        socket.destroy(new LocalSessionError("local_session_timeout", "The daemon did not answer the terminal")),
    );
    socket.on("error", () => {
        clearInterval(heartbeat);
    });
    try {
        const messages = readLocalSessionMessages(socket, signal);
        writeLocalSessionMessage(socket, { kind: "local.session.attach", token, sessionId: options.sessionId });
        const first = (await messages.next()).value;
        const failure = errorSchema.safeParse(first);
        if (failure.success) {
            throw new LocalSessionError(failure.data.code, failure.data.message);
        }
        const attached = attachedSchema.parse(first);
        const [session] = decodeSessionsQueriedEvent(
            JSON.stringify({
                kind: "session.queried",
                requestId: "local-attach",
                entries: [attached.session],
            }),
        ).entries;
        if (session === undefined || session.sessionId !== options.sessionId) {
            throw new LocalSessionError("local_session_scope_mismatch", "The daemon returned another session");
        }
        socket.setTimeout(90_000);
        let awaitingPong = false;
        heartbeat = setInterval(() => {
            if (awaitingPong) {
                socket.destroy(
                    new LocalSessionError("local_session_timeout", "The daemon stopped answering the terminal"),
                );
                return;
            }
            awaitingPong = true;
            writeLocalSessionMessage(socket, { kind: "local.session.ping" });
        }, 30_000);
        const receive = async function* (): AsyncGenerator<DaemonToServiceMessage> {
            for await (const value of messages) {
                if (
                    typeof value === "object" &&
                    value !== null &&
                    Reflect.get(value, "kind") === "local.session.pong"
                ) {
                    awaitingPong = false;
                    continue;
                }
                const failure = errorSchema.safeParse(value);
                if (failure.success) {
                    throw new LocalSessionError(failure.data.code, failure.data.message);
                }
                yield decodeDaemonToServiceMessage(JSON.stringify(value));
            }
        };
        return {
            session,
            bindingId: attached.bindingId,
            messages: receive(),
            close,
            send: (command) => {
                if (socket.destroyed || socket.writableEnded) {
                    throw new LocalSessionError("local_session_closed", "The terminal connection is closed");
                }
                const validated: unknown = JSON.parse(encodeServiceToDaemonMessage(command));
                writeLocalSessionMessage(socket, validated);
            },
            [Symbol.asyncDispose]: async () => {
                close();
            },
        };
    } catch (cause) {
        close();
        signal.throwIfAborted();
        if (cause instanceof LocalSessionError) {
            throw cause;
        }
        throw new LocalSessionError(
            "local_session_connection_failed",
            "Start the Mobius daemon and open the conversation in Morty before connecting the terminal",
            { cause },
        );
    }
}
