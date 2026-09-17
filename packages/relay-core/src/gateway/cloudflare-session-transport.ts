import type { SessionTransport } from "./session-transport.ts";

export type SessionLocationHint =
    | "wnam"
    | "enam"
    | "sam"
    | "weur"
    | "eeur"
    | "apac"
    | "apac-ne"
    | "apac-se"
    | "oc"
    | "afr"
    | "me";

export class CloudflareSessionTransport implements SessionTransport {
    readonly #namespace: DurableObjectNamespace;
    readonly #tenantId: string;
    readonly #locationHint: ((projectId: string) => SessionLocationHint | undefined) | undefined;

    constructor(
        namespace: DurableObjectNamespace,
        tenantId: string,
        locationHint?: (projectId: string) => SessionLocationHint | undefined,
    ) {
        this.#namespace = namespace;
        this.#tenantId = tenantId;
        this.#locationHint = locationHint;
    }

    readonly fetch: SessionTransport["fetch"] = (scope, sessionId, request) => {
        const id = this.#namespace.idFromName(`${this.#tenantId}:${scope.projectId}:${sessionId}`);
        const locationHint = this.#locationHint?.(scope.projectId);
        const session =
            locationHint === undefined ? this.#namespace.get(id) : this.#namespace.get(id, { locationHint });
        return session.fetch(request.url, request);
    };
}
