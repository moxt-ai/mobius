import type { ProjectStore, ProjectStoreResolver } from "@moxt-ai/mobius-relay-core/contracts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";

/** The Platform's operations on one Project's storage, beside the Relay's. The Project Durable Object owns both. */
export interface PlatformProjectStore extends ProjectStore {
    /** Records a Platform audit event; recording the same event again has no effect. */
    readonly recordAudit: (audit: PlatformAuditRecord, signal: AbortSignal) => Promise<void>;
    readonly listAuditEvents: (limit: number, signal: AbortSignal) => Promise<readonly ProjectAuditRow[]>;
    /**
     * When the Project was added to an AppCredential's scope, as recorded in Project storage before D1 owned
     * credential scopes; null when it is not in that scope.
     */
    readonly readLegacyCredentialScope: (credentialId: string, signal: AbortSignal) => Promise<number | null>;
}

export interface PlatformProjectStores extends ProjectStoreResolver {
    readonly forProject: (projectId: string) => PlatformProjectStore;
}
