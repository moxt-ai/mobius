export function truncate(value: string, maximumLength: number): string {
    return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}
