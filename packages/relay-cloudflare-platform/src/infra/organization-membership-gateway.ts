export interface OrganizationMembershipGateway {
    readonly organization: (
        organizationId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly id: string; readonly name: string }>;
    readonly role: (organizationId: string, userId: string, signal: AbortSignal) => Promise<string | null>;
    /** True only when this call creates the membership; existing members retain their role. */
    readonly join: (organizationId: string, userId: string, signal: AbortSignal) => Promise<boolean>;
}
