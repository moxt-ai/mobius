import type { SessionPromptCommand } from "@moxt-ai/mobius-protocol";
import type {
    ArtifactContent,
    ArtifactDescriptor,
    ArtifactUploadAuthorization,
    ArtifactUploadLease,
    AvailableArtifactDescriptor,
    CreateArtifactUploadRequest,
    ProjectScope,
} from "../entity/do/session.ts";
export interface SessionArtifactGateway {
    readonly authorizeArtifactUpload: (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<ArtifactUploadLease>;
    readonly completeArtifactUpload: (
        scope: ProjectScope,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ) => Promise<AvailableArtifactDescriptor>;
    readonly createArtifactUpload: (
        scope: ProjectScope,
        sessionId: string,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ) => Promise<ArtifactUploadAuthorization>;
    readonly readArtifact: (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<ArtifactDescriptor>;
    readonly readArtifactContent: (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ) => Promise<ArtifactContent>;
    readonly resolveArtifactResources: (
        scope: ProjectScope,
        sessionId: string,
        artifactIds: readonly string[],
        signal: AbortSignal,
    ) => Promise<SessionPromptCommand["resources"]>;
}
