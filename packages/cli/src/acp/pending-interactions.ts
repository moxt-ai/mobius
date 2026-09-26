import type {
    CreateElicitationResponse,
    ElicitationContentValue,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export class PendingPermission {
    readonly completion: PromiseWithResolvers<RequestPermissionResponse> =
        Promise.withResolvers<RequestPermissionResponse>();
    readonly interactionId: string;
    readonly optionIds: ReadonlySet<string>;
    #settled = false;

    constructor(interactionId: string, optionIds: ReadonlySet<string>) {
        this.interactionId = interactionId;
        this.optionIds = optionIds;
    }

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ outcome: { outcome: "cancelled" } });
        return true;
    };

    readonly select = (optionId: string): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({
            outcome: { optionId, outcome: "selected" },
        });
        return true;
    };
}

export class PendingElicitation {
    readonly completion: PromiseWithResolvers<CreateElicitationResponse> =
        Promise.withResolvers<CreateElicitationResponse>();
    readonly elicitationId: string;
    readonly interactionId: string;
    readonly requestedSchema: unknown;
    #settled = false;

    constructor(interactionId: string, elicitationId: string, requestedSchema: unknown) {
        this.elicitationId = elicitationId;
        this.interactionId = interactionId;
        this.requestedSchema = requestedSchema;
    }

    readonly accept = (content: Readonly<Record<string, ElicitationContentValue>>): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "accept", content });
        return true;
    };

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "cancel" });
        return true;
    };

    readonly decline = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "decline" });
        return true;
    };
}
