import type { SessionTransport } from "@moxt-ai/mobius-relay-core";

export class CloudflareSessionTransport implements SessionTransport {
    readonly #namespace: DurableObjectNamespace;

    constructor(namespace: DurableObjectNamespace) {
        this.#namespace = namespace;
    }

    readonly fetch: SessionTransport["fetch"] = (scope, sessionId, request) =>
        this.#namespace
            .get(this.#namespace.idFromName(`${scope.tenantId}:${scope.projectId}:${sessionId}`))
            .fetch(request);
}
