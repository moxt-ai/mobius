export interface OrganizationMembershipGateway {
    readonly organization: (
        organizationId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly id: string; readonly name: string }>;
    readonly role: (organizationId: string, userId: string, signal: AbortSignal) => Promise<string | null>;
    readonly join: (organizationId: string, userId: string, signal: AbortSignal) => Promise<void>;
}
