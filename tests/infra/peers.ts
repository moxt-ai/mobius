import { type WebSocket, WebSocketPair } from "miniflare";
import type { ChannelSocket } from "../../packages/relay-core/src/service/channel/channel-actor.ts";
import type {
    RuntimePeers,
    RuntimeService,
    RuntimeSocket,
    RuntimeSocketIdentity,
} from "../../packages/relay-core/src/service/channel/runtime-service.ts";

/** Node's Response constructor rejects 101; the local transport owns the upgrade. */
export class SocketResponse extends Response {
    readonly socket: WebSocket;
    constructor(socket: WebSocket) {
        super(null);
        this.socket = socket;
    }
    override get status(): number {
        return 101;
    }
    override get ok(): boolean {
        return false;
    }
}

class TestSocket implements RuntimeSocket {
    #identity: RuntimeSocketIdentity;
    readonly #socket: WebSocket;
    constructor(identity: RuntimeSocketIdentity, socket: WebSocket) {
        this.#identity = identity;
        this.#socket = socket;
    }
    readonly identity = () => this.#identity;
    readonly close = (code: number, reason: string) => this.#socket.close(code, reason);
    readonly isOpen = () => this.#socket.readyState === 1;
    readonly isSame = (socket: ChannelSocket): boolean => socket === this;
    readonly send = (message: string) => this.#socket.send(message);
    readonly replaceDaemon = () => {
        if (this.#identity.role === "host") {
            throw new Error("A Host cannot replace a Runtime");
        }
        this.#identity = { ...this.#identity, role: "replaced-daemon" };
    };
}

/** Stateful socket peer at the hosting boundary; all messages run through RuntimeService. */
export class TestRuntimePeers implements RuntimePeers, AsyncDisposable {
    readonly #sockets = new Set<TestSocket>();
    readonly #pending = new Set<Promise<void>>();
    readonly #closing = new Set<Promise<void>>();
    readonly #runtime: () => RuntimeService;
    readonly #signal: AbortSignal;
    constructor(runtime: () => RuntimeService, signal: AbortSignal) {
        this.#runtime = runtime;
        this.#signal = signal;
    }
    readonly sockets = () => [...this.#sockets].map((socket) => ({ identity: socket.identity(), socket }));
    readonly daemons = () => [...this.#sockets].filter((socket) => socket.identity().role === "daemon");
    readonly hosts = () => [...this.#sockets].filter((socket) => socket.identity().role === "host");
    readonly accept: RuntimePeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const socket = new TestSocket(identity, pair[1]);
        const closed = Promise.withResolvers<void>();
        this.#closing.add(closed.promise);
        this.#sockets.add(socket);
        const track = (operation: Promise<void>) => {
            this.#pending.add(operation);
            void operation
                .finally(() => this.#pending.delete(operation))
                .catch(() => socket.close(1011, "Runtime transport failed"));
        };
        pair[1].addEventListener("message", (event) => {
            track(this.#runtime().receiveMessage(socket.identity(), socket, event.data, this.#signal));
        });
        pair[1].addEventListener("close", () => {
            this.#sockets.delete(socket);
            track(this.#runtime().detach(socket.identity(), socket, this.#signal));
            closed.resolve();
            this.#closing.delete(closed.promise);
        });
        pair[1].accept();
        return { socket, response: new SocketResponse(pair[0]) };
    };
    async [Symbol.asyncDispose](): Promise<void> {
        for (const socket of this.#sockets) {
            socket.close(1000, "Test completed");
        }
        await Promise.all(this.#closing);
        await Promise.all(this.#pending);
    }
}
