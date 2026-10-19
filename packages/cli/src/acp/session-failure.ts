type AcpSessionFailureCategory = "access" | "connection" | "limit" | "request" | "service" | "unknown";

export interface AcpSessionFailure {
    readonly category: AcpSessionFailureCategory;
    readonly id: string;
    readonly revision: number;
    readonly severity: "error" | "warning";
    readonly title: string;
}

export function sessionFailureMeta(failure: AcpSessionFailure): Readonly<Record<string, unknown>> {
    return {
        jetbrains: {
            air: {
                version: 1,
                sessionFailure: {
                    actions: [],
                    category: failure.category,
                    id: failure.id,
                    revision: failure.revision,
                    severity: failure.severity,
                    title: failure.title,
                },
            },
        },
    };
}
