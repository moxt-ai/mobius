import { hashSecret, PairingDirectoryError } from "../../entity/pairing/pairing.ts";

const DEFAULT_CLIENT_LIMIT = 10;
const DEFAULT_TENANT_LIMIT = 100;
const DEFAULT_WINDOW_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_LIMIT = 100_000;
const MAXIMUM_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface PublicProjectBootstrapEnvironment {
    readonly MOBIUS_TENANT_ID: string;
    readonly PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT?: string;
    readonly PUBLIC_PROJECT_BOOTSTRAP_ENABLED?: string;
    readonly PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT?: string;
    readonly PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS?: string;
}

function configurationInteger(value: unknown, fallback: number, name: string, maximum: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new PairingDirectoryError("configuration_invalid", `The ${name} setting is invalid`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new PairingDirectoryError("configuration_invalid", `The ${name} setting is invalid`);
    }
    return parsed;
}

function configurationEnabled(value: unknown): boolean {
    if (value === undefined || value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new PairingDirectoryError("configuration_invalid", "The PUBLIC_PROJECT_BOOTSTRAP_ENABLED setting is invalid");
}

function normalizedIpv4(value: string): string {
    const parts = value.split(".");
    if (parts.length !== 4) {
        return "";
    }
    const normalized: string[] = [];
    for (const part of parts) {
        if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) {
            return "";
        }
        const octet = Number(part);
        if (octet > 255) {
            return "";
        }
        normalized.push(octet.toString());
    }
    return normalized.join(".");
}

function normalizedIpv6(value: string): string {
    if (!value.includes(":") || value.includes("%") || !/^[0-9a-f:.]+$/.test(value)) {
        return "";
    }
    try {
        const url = new URL(`http://[${value}]/`);
        if (!url.hostname.startsWith("[") || !url.hostname.endsWith("]")) {
            return "";
        }
        return url.hostname.slice(1, -1).toLowerCase();
    } catch {
        return "";
    }
}

function normalizedClientFingerprint(value: string): string {
    const candidate = value.trim().toLowerCase();
    if (candidate === "unavailable") {
        return candidate;
    }
    if (candidate.length < 2 || candidate.length > 45) {
        return "unavailable";
    }
    const ipv4 = normalizedIpv4(candidate);
    if (ipv4.length > 0) {
        return ipv4;
    }
    const ipv6 = normalizedIpv6(candidate);
    return ipv6.length > 0 ? ipv6 : "unavailable";
}

export class PublicProjectBootstrapPolicy {
    readonly #database: D1Database;
    readonly #clientLimit: number;
    readonly #enabled: boolean;
    readonly #tenantId: string;
    readonly #tenantLimit: number;
    readonly #windowMilliseconds: number;

    constructor(
        database: D1Database,
        tenantId: string,
        enabled: boolean,
        clientLimit: number,
        tenantLimit: number,
        windowMilliseconds: number,
    ) {
        if (
            !Number.isSafeInteger(clientLimit) ||
            clientLimit < 1 ||
            clientLimit > MAXIMUM_LIMIT ||
            !Number.isSafeInteger(tenantLimit) ||
            tenantLimit < clientLimit ||
            tenantLimit > MAXIMUM_LIMIT ||
            !Number.isSafeInteger(windowMilliseconds) ||
            windowMilliseconds < 1_000 ||
            windowMilliseconds > MAXIMUM_WINDOW_MILLISECONDS
        ) {
            throw new PairingDirectoryError("configuration_invalid", "The public Project bootstrap policy is invalid");
        }
        this.#database = database;
        this.#tenantId = tenantId;
        this.#enabled = enabled;
        this.#clientLimit = clientLimit;
        this.#tenantLimit = tenantLimit;
        this.#windowMilliseconds = windowMilliseconds;
    }

    readonly authorize = async (clientFingerprint: string, now: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (!this.#enabled) {
            throw new PairingDirectoryError(
                "public_project_bootstrap_disabled",
                "Public accountless Project bootstrap is disabled",
            );
        }
        const digest = await hashSecret(`public-bootstrap\u0000${normalizedClientFingerprint(clientFingerprint)}`);
        signal.throwIfAborted();
        const windowStartsAt = now - this.#windowMilliseconds;
        await this.#database
            .prepare(`DELETE FROM public_project_bootstrap_events WHERE tenant_id = ? AND created_at <= ?`)
            .bind(this.#tenantId, windowStartsAt)
            .run();
        signal.throwIfAborted();
        const inserted = await this.#database
            .prepare(
                `INSERT INTO public_project_bootstrap_events (
                   event_id, tenant_id, client_fingerprint, created_at
                 )
                 SELECT ?, ?, ?, ?
                  WHERE (
                    SELECT COUNT(*) FROM public_project_bootstrap_events
                     WHERE tenant_id = ? AND client_fingerprint = ? AND created_at > ?
                  ) < ?
                    AND (
                      SELECT COUNT(*) FROM public_project_bootstrap_events
                       WHERE tenant_id = ? AND created_at > ?
                    ) < ?`,
            )
            .bind(
                `pbe_${crypto.randomUUID()}`,
                this.#tenantId,
                digest,
                now,
                this.#tenantId,
                digest,
                windowStartsAt,
                this.#clientLimit,
                this.#tenantId,
                windowStartsAt,
                this.#tenantLimit,
            )
            .run();
        signal.throwIfAborted();
        if (inserted.meta.changes !== 1) {
            throw new PairingDirectoryError(
                "public_project_bootstrap_rate_limited",
                "Public accountless Project bootstrap is temporarily rate limited",
            );
        }
    };
}

export function publicProjectBootstrapPolicyFromEnvironment(
    database: D1Database,
    environment: PublicProjectBootstrapEnvironment,
): PublicProjectBootstrapPolicy {
    return new PublicProjectBootstrapPolicy(
        database,
        environment.MOBIUS_TENANT_ID,
        configurationEnabled(environment.PUBLIC_PROJECT_BOOTSTRAP_ENABLED),
        configurationInteger(
            environment.PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT,
            DEFAULT_CLIENT_LIMIT,
            "PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT",
            MAXIMUM_LIMIT,
        ),
        configurationInteger(
            environment.PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT,
            DEFAULT_TENANT_LIMIT,
            "PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT",
            MAXIMUM_LIMIT,
        ),
        configurationInteger(
            environment.PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS,
            DEFAULT_WINDOW_MILLISECONDS / 1_000,
            "PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS",
            MAXIMUM_WINDOW_MILLISECONDS / 1_000,
        ) * 1_000,
    );
}
