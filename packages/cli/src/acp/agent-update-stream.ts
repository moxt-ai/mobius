import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "./acp-error.ts";
import { nativeSessionIdSchema } from "./native-session.ts";

const MAX_PENDING_UPDATES = 100;
const MAX_PENDING_BYTES = 1024 * 1024;

type Selection =
    | {
          readonly kind: "awaiting-session";
          readonly notifications: readonly SessionNotification[];
          readonly bytes: number;
      }
    | { readonly kind: "selected"; readonly sessionId: string };

/** Owns session selection and ordered delivery, including updates received before selection. */
export class AgentUpdateStream {
    #selection: Selection = { kind: "awaiting-session", notifications: [], bytes: 0 };
    #tail: Promise<void> = Promise.resolve();
    readonly #consume: (notification: SessionNotification) => Promise<void>;

    constructor(consume: (notification: SessionNotification) => Promise<void>) {
        this.#consume = consume;
    }

    readonly sessionId = (): string => (this.#selection.kind === "selected" ? this.#selection.sessionId : "");
    readonly drained = (): Promise<void> => this.#tail;

    readonly #enqueue = (notification: SessionNotification): Promise<void> => {
        this.#tail = this.#tail.then(async () => await this.#consume(notification));
        return this.#tail;
    };

    readonly receive = (notification: SessionNotification): Promise<void> => {
        const selection = this.#selection;
        switch (selection.kind) {
            case "selected":
                return this.#enqueue(notification);
            case "awaiting-session": {
                const bytes = selection.bytes + Buffer.byteLength(JSON.stringify(notification));
                if (selection.notifications.length >= MAX_PENDING_UPDATES || bytes > MAX_PENDING_BYTES) {
                    return Promise.reject(
                        new AcpExecutionError(
                            "ACP agent sent too many updates before creating its session",
                            {},
                            "agent_update_limit",
                        ),
                    );
                }
                this.#selection = {
                    kind: "awaiting-session",
                    notifications: [...selection.notifications, notification],
                    bytes,
                };
                return Promise.resolve();
            }
        }
    };

    readonly select = (sessionId: string): void => {
        const selected = nativeSessionIdSchema.parse(sessionId);
        const selection = this.#selection;
        switch (selection.kind) {
            case "selected":
                if (selection.sessionId !== selected) {
                    throw new AcpExecutionError(
                        "ACP agent attempted to replace the selected session",
                        {},
                        "invalid_agent_session",
                    );
                }
                return;
            case "awaiting-session":
                this.#selection = { kind: "selected", sessionId: selected };
                for (const notification of selection.notifications) {
                    void this.#enqueue(notification);
                }
                return;
        }
    };
}
