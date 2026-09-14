import type { SessionTransport } from "./session-transport.ts";

export class CloudflareSessionTransport implements SessionTransport {
    readonly #namespace: DurableObjectNamespace;
    readonly #tenantId: string;

    constructor(namespace: DurableObjectNamespace, tenantId: string) {
        this.#namespace = namespace;
        this.#tenantId = tenantId;
    }

    readonly fetch: SessionTransport["fetch"] = (scope, sessionId, request) =>
        this.#namespace
            .get(this.#namespace.idFromName(`${this.#tenantId}:${scope.projectId}:${sessionId}`))
            .fetch(request.url, request);
}
