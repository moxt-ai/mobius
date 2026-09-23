import type { RuntimeConnectionIdentity } from "../../entity/channel/runtime-connection.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type { RuntimeConnectionStorage } from "../../storage/runtime-connection-storage.ts";

export class RuntimeConnectionService {
    readonly #storage: RuntimeConnectionStorage;

    constructor(storage: RuntimeConnectionStorage) {
        this.#storage = storage;
    }

    readonly current = () => this.#storage.read();
    readonly isRevoked = (runtimeId: string, scope: ProjectScope) => this.#storage.isRevoked(runtimeId, scope);
    readonly revoke = (runtimeId: string, scope: ProjectScope, now: number) =>
        this.#storage.revoke(runtimeId, scope, now);

    readonly prepare = (
        runtimeId: string,
        scope: ProjectScope,
    ):
        | { readonly kind: "conflict" }
        | { readonly kind: "revoked" }
        | { readonly kind: "ready"; readonly identity: RuntimeConnectionIdentity } => {
        if (this.#storage.isRevoked(runtimeId, scope)) {
            return { kind: "revoked" };
        }
        const previous = this.#storage.read();
        if (previous !== null && previous.runtimeId !== runtimeId) {
            return { kind: "conflict" };
        }
        return {
            kind: "ready",
            identity: {
                runtimeId,
                connectionEpoch: (previous?.connectionEpoch ?? 0) + 1,
                connectionId: `cnn_${crypto.randomUUID()}`,
            },
        };
    };

    readonly isCurrent = (identity: RuntimeConnectionIdentity): boolean => {
        const current = this.#storage.read();
        return (
            current?.state === "online" &&
            current.runtimeId === identity.runtimeId &&
            current.connectionEpoch === identity.connectionEpoch &&
            current.connectionId === identity.connectionId
        );
    };

    readonly connected = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#storage.connect(identity, now);
    };

    readonly disconnected = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#storage.disconnect(identity, now);
    };
}
