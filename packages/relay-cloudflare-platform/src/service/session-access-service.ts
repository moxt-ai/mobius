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
    ProjectPermission.ConversationTurnCreate,
    ProjectPermission.ConversationTurnCancel,
    ProjectPermission.ProjectEventsRead,
]);

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

    readonly authorizer = (request: Request): ProjectAccessAuthorizer => ({
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
            const prefix = `/mobius/api/v1/projects/${encodeURIComponent(row.project_id)}/sessions/${encodeURIComponent(row.session_id)}`;
            const path = new URL(request.url).pathname;
            const suffix = path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path === prefix ? "" : null;
            const allowed =
                suffix !== null &&
                ((request.method === "GET" &&
                    /^(?:|\/(?:messages|native-history|events)|\/turns\/[A-Za-z0-9._:-]+|\/artifacts\/[A-Za-z0-9._:-]+(?:\/content)?)$/u.test(
                        suffix,
                    )) ||
                    (request.method === "POST" &&
                        /^\/(?:turns|prepare|configuration|turns\/[A-Za-z0-9._:-]+\/cancel)$/u.test(suffix)));
            if (!allowed || row.project_id !== projectId || !permissions.has(permission)) {
                throw new ProjectAuthenticationError(
                    "project_permission_denied",
                    "The credential authorizes only the selected Session",
                );
            }
            return new ProjectAccessContext(
                new ProjectScope(projectId),
                permissions,
                new AuditActor(AuditActorKind.BrowserAccess, row.credential_id),
                row.credential_id,
                Date.now(),
                new ExpiringProjectAccessLifetime(row.expires_at),
            );
        },
    });
}
