import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    ExpiringProjectAccessLifetime,
    hashSecret,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectPermission,
    ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import type { SessionAccessStorage } from "../storage/session-access-storage.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

const tokenPattern = /^msession_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/u;
const permissions = new Set([
    ProjectPermission.ArtifactRead,
    ProjectPermission.SessionRead,
    ProjectPermission.SessionWrite,
    ProjectPermission.InteractionRespond,
    ProjectPermission.ProjectEventsRead,
]);

export type SessionAccessTarget =
    | { readonly kind: "session"; readonly projectId: string; readonly sessionId: string }
    | { readonly kind: "unavailable" };

export class SessionAccessService {
    private readonly storage: SessionAccessStorage;
    private readonly control: PlatformControlPlaneService;
    constructor(storage: SessionAccessStorage, control: PlatformControlPlaneService) {
        this.storage = storage;
        this.control = control;
    }

    readonly issue = async (
        projectId: string,
        sessionId: string,
        token: string,
        seconds: number,
        signal: AbortSignal,
    ) => {
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
            throw new ProjectAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        const parent = await this.control.authorizePlatformCredential(
            projectId,
            token,
            ProjectPermission.SessionWrite,
            "",
            signal,
        );
        if ([...permissions].some((permission) => !parent.project.permits(permission))) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The App does not authorize interactive Session access",
            );
        }
        const publicId = createRandomToken(16);
        const credentialId = `sac_${publicId}`;
        const secret = createRandomToken(32);
        const expiresAt = Math.min(Date.now() + seconds * 1000, parent.project.lifetime.expiresAtEpochMilliseconds);
        await this.storage.insert(
            {
                credential_id: credentialId,
                secret_digest: await hashSecret(secret),
                project_id: projectId,
                session_id: validateIdentifier(sessionId, "session_id"),
                parent_credential_id: parent.project.credentialId,
                parent_revision: parent.credentialRevision,
                expires_at: expiresAt,
            },
            signal,
        );
        return {
            credential: `msession_${publicId}_${secret}`,
            credentialId,
            projectId,
            sessionId,
            expiresAt: new Date(expiresAt).toISOString(),
        };
    };

    readonly authorizer = (target: () => SessionAccessTarget): ProjectAccessAuthorizer => ({
        authorizeProject: async (projectId, token, permission, actor, signal) => {
            if (!token.startsWith("msession_")) {
                return await this.control.authorizeProject(projectId, token, permission, actor, signal);
            }
            const match = tokenPattern.exec(token);
            if (match === null || match[1] === undefined || match[2] === undefined) {
                throw new ProjectAuthenticationError("project_credential_invalid", "The Session credential is invalid");
            }
            const row = await this.storage.readActive(projectId, `sac_${match[1]}`, Date.now(), signal);
            const digest = await hashSecret(match[2]);
            signal.throwIfAborted();
            let mismatch = (row?.secret_digest.length ?? 0) ^ digest.length;
            for (let index = 0; index < digest.length; index += 1) {
                mismatch |= (row?.secret_digest.charCodeAt(index) ?? 0) ^ digest.charCodeAt(index);
            }
            if (row === null || mismatch !== 0) {
                throw new ProjectAuthenticationError("credential_expired", "The Session credential is unavailable");
            }
            const resolvedTarget = target();
            if (
                resolvedTarget.kind !== "session" ||
                resolvedTarget.projectId !== row.project_id ||
                resolvedTarget.sessionId !== row.session_id ||
                row.project_id !== projectId ||
                !permissions.has(permission)
            ) {
                throw new ProjectAuthenticationError(
                    "project_permission_denied",
                    "The credential authorizes only the selected Session",
                );
            }
            return new ProjectAccessContext(
                new ProjectScope(projectId),
                true,
                permissions,
                new AuditActor(AuditActorKind.BrowserAccess, row.credential_id),
                row.credential_id,
                Date.now(),
                new ExpiringProjectAccessLifetime(row.expires_at),
            );
        },
    });
}
