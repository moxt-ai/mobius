import { setImmediate as yieldToRuntime } from "node:timers/promises";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "./acp-error.ts";
import { nativeSessionIdSchema } from "./native-session.ts";

const MAX_PENDING_UPDATES = 100;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_SELECTED_UPDATES = 2048;
const MAX_SELECTED_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_QUEUED_BYTES = 64 * 1024 * 1024;
const UPDATES_PER_YIELD = 32;
let runtimeQueuedBytes = 0;
let updatesSinceYield = 0;

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
    #pendingUpdates = 0;
    #pendingBytes = 0;
    #state: "open" | "failed" = "open";
    readonly #consume: (notification: SessionNotification) => Promise<void>;

    constructor(consume: (notification: SessionNotification) => Promise<void>) {
        this.#consume = consume;
    }

    readonly sessionId = (): string => (this.#selection.kind === "selected" ? this.#selection.sessionId : "");
    readonly drained = (): Promise<void> => this.#tail;

    readonly #enqueue = (notification: SessionNotification): Promise<void> => {
        if (this.#state === "failed") {
            return this.#tail;
        }
        const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
        if (
            this.#pendingUpdates >= MAX_SELECTED_UPDATES ||
            this.#pendingBytes + bytes > MAX_SELECTED_BYTES ||
            runtimeQueuedBytes + bytes > MAX_RUNTIME_QUEUED_BYTES
        ) {
            this.#state = "failed";
            this.#tail = this.#tail.then(() => {
                throw new AcpExecutionError("The Agent output processing queue is full", {}, "agent_update_limit");
            });
            return this.#tail;
        }
        this.#pendingUpdates += 1;
        this.#pendingBytes += bytes;
        runtimeQueuedBytes += bytes;
        this.#tail = this.#tail
            .then(async () => {
                updatesSinceYield += 1;
                if (updatesSinceYield >= UPDATES_PER_YIELD) {
                    updatesSinceYield = 0;
                    await yieldToRuntime();
                }
                await this.#consume(notification);
            })
            .finally(() => {
                this.#pendingUpdates -= 1;
                this.#pendingBytes -= bytes;
                runtimeQueuedBytes -= bytes;
            })
            .catch((error: unknown) => {
                this.#state = "failed";
                throw error;
            });
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
