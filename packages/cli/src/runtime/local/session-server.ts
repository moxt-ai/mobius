import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
    type DaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    isIdentifier,
    type SessionMetadata,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import { readOrCreateControlToken } from "../../storage/daemon/control-token.ts";
import { acquireManagerLock } from "../../storage/daemon/manager-lock.ts";
import { platformSupportFor } from "../../util/platform/index.ts";
import type { CommandContext } from "../command/context.ts";
import { createRuntimeCommandDispatcher } from "../command/dispatcher.ts";
import type { RuntimeSessionEventPublisher } from "../relay/session-event-publisher.ts";
import {
    LocalSessionError,
    localSessionSocketPath,
    readLocalSessionMessages,
    writeLocalSessionMessage,
} from "./session-stream.ts";

const attachSchema = z.object({
    kind: z.literal("local.session.attach"),
    token: z.string().min(1).max(256),
    sessionId: z.string().refine(isIdentifier),
});

type LocalSessionContext = Omit<CommandContext, "transport" | "signal"> & {
    readonly publisher: RuntimeSessionEventPublisher;
};

function authenticate(provided: string, expected: string): boolean {
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function authorizeCommand(value: unknown, session: SessionMetadata, bindingId: string) {
    const message = decodeServiceToDaemonMessage(JSON.stringify(value));
    switch (message.kind) {
        case "session.prompt":
            if (
                message.agentId !== session.agentId ||
                message.bindingId !== bindingId ||
                message.directoryId !== session.directoryId ||
                JSON.stringify(message.additionalDirectoryIds) !==
                    JSON.stringify(session.additionalDirectories.map((entry) => entry.directoryId))
            ) {
                throw new LocalSessionError(
                    "local_session_scope_mismatch",
                    "The command does not match the connected session",
                );
            }
            break;
        case "session.cancel":
        case "session.elicitation.respond":
        case "session.permission.respond":
            break;
        default:
            throw new LocalSessionError(
                "local_session_command_unsupported",
                "This command is unavailable in the terminal",
            );
    }
    if (message.sessionId !== session.sessionId) {
        throw new LocalSessionError("local_session_scope_mismatch", "The command belongs to another session");
    }
    return message;
}

export async function serveLocalSessions(context: LocalSessionContext, signal: AbortSignal): Promise<AsyncDisposable> {
    signal.throwIfAborted();
    const stateDirectory = context.config.localContext.stateDirectory;
    const token = await readOrCreateControlToken(stateDirectory);
    const path = localSessionSocketPath(stateDirectory, context.config.channelId);
    const platform = platformSupportFor(process.platform);
    const sockets = new Set<Socket>();
    const tasks = new Set<Promise<void>>();
    const serve = async (socket: Socket): Promise<void> => {
        const disconnected = new AbortController();
        const lifetime = AbortSignal.any([signal, disconnected.signal]);
        socket.once("close", () => disconnected.abort());
        // Authentication has a short deadline; authenticated clients send heartbeat frames.
        socket.setTimeout(10_000, () => socket.destroy());
        let unsubscribe = (): void => {};
        let dispatcher: ReturnType<typeof createRuntimeCommandDispatcher> | null = null;
        const messages = readLocalSessionMessages(socket, lifetime);
        try {
            const first = attachSchema.parse((await messages.next()).value);
            if (!authenticate(first.token, token)) {
                throw new LocalSessionError(
                    "local_session_unauthorized",
                    "The terminal is not authorized for this daemon",
                );
            }
            const [session] = await context.nativeSessions.querySessions(
                [first.sessionId],
                AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]),
            );
            if (session === undefined) {
                throw new LocalSessionError(
                    "local_session_not_found",
                    "Open this conversation in Morty before connecting the terminal",
                );
            }
            const transport = {
                isOpen: () => !socket.destroyed && !socket.writableEnded,
                send: (message: DaemonToServiceMessage) => writeLocalSessionMessage(socket, message),
            };
            dispatcher = createRuntimeCommandDispatcher({ ...context, transport, signal: lifetime });
            unsubscribe = context.publisher.subscribe(session.sessionId, transport.send);
            socket.setTimeout(90_000);
            context.diagnostics.daemonDiagnostic("local_session_attached", session.sessionId, {
                agentId: session.agentId,
            });
            writeLocalSessionMessage(socket, {
                kind: "local.session.attached",
                bindingId: context.config.bindingId,
                session,
            });
            const snapshot = await context.nativeSessions.execute(
                {
                    kind: "native.session.request",
                    action: "active-turn",
                    requestId: "local-attach",
                    sessionId: session.sessionId,
                    targetSessionId: session.sessionId,
                    agentId: session.agentId,
                    bindingId: context.config.bindingId,
                    directoryId: session.directoryId,
                    additionalDirectoryIds: session.additionalDirectories.map((entry) => entry.directoryId),
                },
                AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]),
            );
            writeLocalSessionMessage(socket, snapshot);
            for await (const value of messages) {
                if (
                    typeof value === "object" &&
                    value !== null &&
                    Reflect.get(value, "kind") === "local.session.ping"
                ) {
                    writeLocalSessionMessage(socket, { kind: "local.session.pong" });
                    continue;
                }
                const message = authorizeCommand(value, session, context.config.bindingId);
                context.diagnostics.daemonDiagnostic("local_session_command", session.sessionId, {
                    kind: message.kind,
                });
                dispatcher.dispatch(message);
            }
        } catch (cause) {
            if (!lifetime.aborted) {
                writeLocalSessionMessage(socket, {
                    kind: "local.session.error",
                    code: cause instanceof LocalSessionError ? cause.code : "local_session_failed",
                    message:
                        cause instanceof LocalSessionError
                            ? cause.message
                            : "The terminal could not connect to this session",
                });
            }
        } finally {
            unsubscribe();
            await messages.return(undefined);
            await dispatcher?.settle();
            socket.end(() => socket.destroy());
        }
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        const task = serve(socket).catch((cause: unknown) => {
            socket.destroy();
            if (!signal.aborted) {
                context.diagnostics.daemonDiagnostic("local_session_failed", "", {
                    code: cause instanceof LocalSessionError ? cause.code : "local_session_failed",
                });
            }
        });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
    });
    const stop = (): void => {
        for (const socket of sockets) {
            socket.destroy();
        }
    };
    const lockName = `session-${createHash("sha256").update(context.config.channelId).digest("hex").slice(0, 32)}.lock`;
    const release = await acquireManagerLock(stateDirectory, lockName);
    if (release === null) {
        throw new LocalSessionError(
            "local_session_already_running",
            "This runtime already has a local terminal server",
        );
    }
    try {
        await platform.prepareControlSocket(path);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(path, resolve);
        });
        await platform.secureControlSocket(path);
        signal.addEventListener("abort", stop, { once: true });
        signal.throwIfAborted();
        return {
            [Symbol.asyncDispose]: async () => {
                signal.removeEventListener("abort", stop);
                stop();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await Promise.all(tasks);
                try {
                    await platform.removeControlSocket(path);
                } finally {
                    await release();
                }
            },
        };
    } catch (cause) {
        stop();
        server.close();
        try {
            await platform.removeControlSocket(path);
        } finally {
            await release();
        }
        throw cause;
    }
}
