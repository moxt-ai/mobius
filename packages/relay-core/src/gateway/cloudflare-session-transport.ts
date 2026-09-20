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
    readonly #nonCloudRetentionNamespace: DurableObjectNamespace | null;
    readonly #namespacePrefix: string;
    readonly #locationHint: ((projectId: string) => SessionLocationHint | undefined) | undefined;

    constructor(
        namespace: DurableObjectNamespace,
        namespacePrefix: string,
        locationHint?: (projectId: string) => SessionLocationHint | undefined,
        nonCloudRetentionNamespace: DurableObjectNamespace | null = null,
    ) {
        this.#namespace = namespace;
        this.#nonCloudRetentionNamespace = nonCloudRetentionNamespace;
        this.#namespacePrefix = namespacePrefix;
        this.#locationHint = locationHint;
    }

    readonly fetch: SessionTransport["fetch"] = ({ cloudRetention, runtimeId, scope, sessionId }, request) => {
        const namespace = cloudRetention ? this.#namespace : this.#nonCloudRetentionNamespace;
        if (namespace === null) {
            throw new Error("Non-cloud-retention Session relay storage is unavailable");
        }
        const objectName = `${this.#namespacePrefix}:${scope.projectId}:${sessionId}`;
        const id = namespace.idFromName(objectName);
        const locationHint = this.#locationHint?.(scope.projectId);
        const session = locationHint === undefined ? namespace.get(id) : namespace.get(id, { locationHint });
        if (cloudRetention) {
            return session.fetch(request.url, request);
        }
        const endpoint = new URL(request.url);
        const operationPrefix = "/internal/sessions/";
        if (!endpoint.pathname.startsWith(operationPrefix)) {
            throw new Error("The non-cloud-retention Session operation route is invalid");
        }
        const operation = endpoint.pathname.slice(operationPrefix.length);
        endpoint.pathname = `/internal/projects/${encodeURIComponent(scope.projectId)}/runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/${operation}`;
        return session.fetch(endpoint, request);
    };
}
