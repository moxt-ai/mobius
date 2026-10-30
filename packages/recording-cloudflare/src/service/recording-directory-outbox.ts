import type { RecordingDirectoryUpdate } from "../entity/recording-directory-update.ts";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";
import { pendingDirectoryUpdate } from "./recording-directory-update.ts";

/** Committed changes read per delivery step; each step sends one directory update. */
const pendingReadLimit = 64;

/** Sends one update to the directory; true only once the directory confirms it. */
export type SendDirectoryUpdate = (update: RecordingDirectoryUpdate) => Promise<boolean>;

/**
 * Applies a Session's committed directory changes to the directory index, oldest first. Deliveries run one at a
 * time, so the directory sees the Session's changes in commit order, and a change stays committed until the
 * directory confirms it.
 */
export class RecordingDirectoryOutbox {
    readonly #storage: Pick<SessionRecordingStorage, "confirmDirectory" | "identity" | "pendingDirectory">;
    readonly #send: SendDirectoryUpdate;
    #delivery: Promise<boolean> = Promise.resolve(true);
    // The delivery waiting for the one in flight. It reads every change committed before it starts, so later
    // callers share it, and a slow directory leaves at most one delivery waiting however many batches commit.
    #waiting: Promise<boolean> | undefined;

    constructor(
        storage: Pick<SessionRecordingStorage, "confirmDirectory" | "identity" | "pendingDirectory">,
        send: SendDirectoryUpdate,
    ) {
        this.#storage = storage;
        this.#send = send;
    }

    /** True once every committed change is confirmed; false leaves the rest for a later delivery. */
    readonly deliver = (): Promise<boolean> => {
        if (this.#waiting === undefined) {
            this.#waiting = this.#delivery.then(this.#start, this.#start);
            this.#delivery = this.#waiting;
        }
        return this.#waiting;
    };

    readonly #start = (): Promise<boolean> => {
        this.#waiting = undefined;
        return this.#deliverPending();
    };

    readonly #deliverPending = async (): Promise<boolean> => {
        const identity = this.#storage.identity();
        if (identity === null) {
            return true;
        }
        for (;;) {
            const next = pendingDirectoryUpdate(identity, this.#storage.pendingDirectory(pendingReadLimit));
            if (next === null) {
                return true;
            }
            if (!(await this.#send(next.update))) {
                return false;
            }
            this.#storage.confirmDirectory(next.through);
        }
    };
}
