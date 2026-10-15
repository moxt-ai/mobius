import type { RuntimeUpgradeResult } from "@moxt-ai/mobius-protocol";
export function sanitizedUpgradeError(value: string): string {
    return value
        .replace(/(?:Bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "[redacted]")
        .replace(/(?:mapp_|mobius_[a-z_]*v\d\.)[A-Za-z0-9_.-]+/g, "[redacted]")
        .slice(-4096);
}
export class UpgradeErrorReporting {
    private readonly dsn: string | undefined;
    private readonly transport: typeof fetch;
    constructor(dsn: string | undefined, transport: typeof fetch = fetch) {
        this.dsn = dsn;
        this.transport = transport;
    }
    readonly report = async (
        appId: string,
        runtimeId: string,
        projectId: string,
        result: RuntimeUpgradeResult,
        signal: AbortSignal,
    ): Promise<void> => {
        if (!this.dsn || result.outcome.status !== "failed") {
            return;
        }
        const dsn = new URL(this.dsn);
        if (dsn.protocol !== "https:") {
            return;
        }
        const segments = dsn.pathname.split("/");
        const project = segments.pop();
        const prefix = segments.join("/");
        if (!project || !dsn.username) {
            throw new Error("Invalid upgrade error reporting configuration");
        }
        const endpoint = new URL(`${prefix}/api/${project}/envelope/`, dsn.origin);
        const eventId = crypto.randomUUID().replaceAll("-", "");
        const event = {
            event_id: eventId,
            timestamp: Date.now() / 1000,
            platform: "javascript",
            level: "error",
            message: `Runtime upgrade failed: ${result.outcome.code}`,
            tags: { appId, runtimeId, projectId, code: result.outcome.code },
            extra: {
                requestId: result.requestId,
                version: result.version,
                targetVersion: result.targetVersion,
                message: sanitizedUpgradeError(result.outcome.message),
                stdout: sanitizedUpgradeError(result.outcome.stdout ?? ""),
                stderr: sanitizedUpgradeError(result.outcome.stderr ?? ""),
            },
        };
        const response = await this.transport(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/x-sentry-envelope",
                "x-sentry-auth": `Sentry sentry_version=7,sentry_key=${dsn.username},sentry_client=mobius-upgrade/1`,
            },
            body: [
                JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
                JSON.stringify({ type: "event" }),
                JSON.stringify(event),
            ].join("\n"),
            signal,
        });
        if (!response.ok) {
            throw new Error("Upgrade error reporting failed");
        }
    };
}
