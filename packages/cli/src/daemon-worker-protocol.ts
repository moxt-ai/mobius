export class DaemonWorkerError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "DaemonWorkerError";
        this.code = code;
    }
}

export type WorkerEvent =
    | { readonly kind: "status"; readonly status: "online" | "reconnecting" }
    | { readonly kind: "failed"; readonly code: string; readonly message: string };

export function decodeWorkerEvent(value: unknown): WorkerEvent {
    if (typeof value === "object" && value !== null) {
        if (
            "kind" in value &&
            value.kind === "status" &&
            "status" in value &&
            (value.status === "online" || value.status === "reconnecting")
        ) {
            return { kind: "status", status: value.status };
        }
        if (
            "kind" in value &&
            value.kind === "failed" &&
            "code" in value &&
            typeof value.code === "string" &&
            "message" in value &&
            typeof value.message === "string"
        ) {
            return { kind: "failed", code: value.code, message: value.message };
        }
    }
    throw new DaemonWorkerError("worker_protocol_invalid", "Invalid daemon worker event");
}
