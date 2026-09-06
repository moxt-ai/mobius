import {
  DEFAULT_SESSION_QUOTA_POLICY,
  SessionQuotaPolicy,
} from "@moxt-ai/mobius-relay-core";

export interface SessionConfigurationEnvironment {
  readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
  readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
}

function readLimit(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
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

export function sessionQuotaFromEnvironment(
  environment: SessionConfigurationEnvironment,
): SessionQuotaPolicy {
  return new SessionQuotaPolicy(
    readLimit(
      environment.SESSION_ACTIVE_SESSIONS_PER_TENANT,
      DEFAULT_SESSION_QUOTA_POLICY.activeSessionsPerTenant,
      "SESSION_ACTIVE_SESSIONS_PER_TENANT",
    ),
    readLimit(
      environment.SESSION_ACTIVE_SESSIONS_PER_PROJECT,
      DEFAULT_SESSION_QUOTA_POLICY.activeSessionsPerProject,
      "SESSION_ACTIVE_SESSIONS_PER_PROJECT",
    ),
  );
}
