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
    readonly #namespacePrefix: string;
    readonly #locationHint: ((projectId: string) => SessionLocationHint | undefined) | undefined;

    constructor(
        namespace: DurableObjectNamespace,
        namespacePrefix: string,
        locationHint?: (projectId: string) => SessionLocationHint | undefined,
    ) {
        this.#namespace = namespace;
        this.#namespacePrefix = namespacePrefix;
        this.#locationHint = locationHint;
    }

    readonly fetch: SessionTransport["fetch"] = ({ runtimeId, scope, sessionId }, request) => {
        const objectName = `${this.#namespacePrefix}:${scope.projectId}:${sessionId}`;
        const id = this.#namespace.idFromName(objectName);
        const locationHint = this.#locationHint?.(scope.projectId);
        const session =
            locationHint === undefined ? this.#namespace.get(id) : this.#namespace.get(id, { locationHint });
        const endpoint = new URL(request.url);
        const operationPrefix = "/internal/sessions/";
        if (!endpoint.pathname.startsWith(operationPrefix)) {
            throw new Error("The Session operation route is invalid");
        }
        const operation = endpoint.pathname.slice(operationPrefix.length);
        endpoint.pathname = `/internal/projects/${encodeURIComponent(scope.projectId)}/runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/${operation}`;
        return session.fetch(endpoint, request);
    };
}
