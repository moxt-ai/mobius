import { DEFAULT_SESSION_QUOTA_POLICY, SessionQuotaPolicy } from "../entity/do/session.ts";

export interface SessionConfigurationEnvironment {
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
}

export type LiteSessionConfigurationEnvironment = SessionConfigurationEnvironment;

function readLimit(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) {
        return fallback;
    }
    if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error(`${name} must be a positive integer`);
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit)) {
        throw new Error(`${name} must be a safe integer`);
    }
    return limit;
}

export function sessionQuotaFromEnvironment(environment: SessionConfigurationEnvironment): SessionQuotaPolicy {
    return new SessionQuotaPolicy(
        readLimit(
            environment.SESSION_ACTIVE_SESSIONS_PER_PROJECT,
            DEFAULT_SESSION_QUOTA_POLICY.activeSessionsPerProject,
            "SESSION_ACTIVE_SESSIONS_PER_PROJECT",
        ),
    );
}
