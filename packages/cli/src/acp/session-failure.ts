import { isRecord, truncate } from "./value-utils.ts";

type AcpSessionFailureCategory = "access" | "connection" | "limit" | "request" | "service" | "unknown";

const CATEGORIES: ReadonlySet<string> = new Set<AcpSessionFailureCategory>([
    "access",
    "connection",
    "limit",
    "request",
    "service",
    "unknown",
]);

function isCategory(value: unknown): value is AcpSessionFailureCategory {
    return typeof value === "string" && CATEGORIES.has(value);
}

export interface AcpSessionFailure {
    readonly category: AcpSessionFailureCategory;
    readonly id: string;
    readonly revision: number;
    readonly severity: "error" | "warning";
    readonly title: string;
}

function child(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

export function readAcpSessionFailure(value: unknown): AcpSessionFailure | null {
    const meta = child(value, "_meta");
    const jetbrains = child(meta, "jetbrains");
    const air = child(jetbrains, "air");
    const failure = child(air, "sessionFailure");
    if (!isRecord(air) || !Number.isInteger(air["version"]) || Number(air["version"]) < 1 || !isRecord(failure)) {
        return null;
    }
    const id = failure["id"];
    const revision = failure["revision"];
    const category = failure["category"];
    const severity = failure["severity"];
    const title = failure["title"];
    if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 512 ||
        !Number.isInteger(revision) ||
        Number(revision) < 1 ||
        !isCategory(category) ||
        (severity !== "warning" && severity !== "error") ||
        typeof title !== "string" ||
        title.length === 0
    ) {
        return null;
    }
    return {
        category,
        id,
        revision: Number(revision),
        severity,
        title: truncate(title, 4_096),
    };
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
