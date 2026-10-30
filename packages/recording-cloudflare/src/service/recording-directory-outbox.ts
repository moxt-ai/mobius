import type { RecordingDirectoryUpdate } from "../entity/recording-directory-update.ts";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";
import { pendingDirectoryUpdate } from "./recording-directory-update.ts";

/** Committed changes read per delivery step; each step sends one directory update. */
const pendingReadLimit = 64;

/**
 * Applies a Session's committed directory changes to the directory index, oldest first. Deliveries run one at a
 * time, so the directory sees the Session's changes in commit order, and a change stays committed until the
 * directory confirms it.
 */
export class RecordingDirectoryOutbox {
    readonly #storage: Pick<SessionRecordingStorage, "confirmDirectory" | "identity" | "pendingDirectory">;
    readonly #send: (update: RecordingDirectoryUpdate) => Promise<boolean>;
    #delivery: Promise<boolean> = Promise.resolve(true);

    constructor(
        storage: Pick<SessionRecordingStorage, "confirmDirectory" | "identity" | "pendingDirectory">,
        send: (update: RecordingDirectoryUpdate) => Promise<boolean>,
    ) {
        this.#storage = storage;
        this.#send = send;
    }

    /**
     * True once every committed change is confirmed; false leaves the rest for a later delivery. It never rejects:
     * the changes are already committed with their batches, so failing to index them fails neither those writes nor
     * other work waiting behind the delivery.
     */
    readonly deliver = (): Promise<boolean> => {
        this.#delivery = this.#delivery.then(this.#deliverPending);
        return this.#delivery;
    };

    readonly #deliverPending = async (): Promise<boolean> => {
        try {
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
        } catch (cause) {
            console.warn("Recording directory changes could not be delivered", {
                code: "recording_directory_delivery_failed",
                cause,
            });
            return false;
        }
    };
}
