import type { ProjectLocationHint } from "@moxt-ai/mobius-protocol";
import {
    AuditActorKind,
    type ExternalIdentityAuthenticator,
    type HttpError,
    type ProjectAccessContext,
    type ProjectPermission,
    type VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core/contracts";

export class PlatformAuditActorKind extends AuditActorKind {
    static readonly Application = new PlatformAuditActorKind("application");
}

export class PlatformControlPlaneError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PlatformControlPlaneError";
        this.status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
    });
}

export class PlatformAuthenticationConfiguration {
    readonly allowedOrigins: ReadonlySet<string>;
    readonly developerAuthenticator: ExternalIdentityAuthenticator;
    readonly operatorSubjects: ReadonlySet<string>;

    constructor(
        developerAuthenticator: ExternalIdentityAuthenticator,
        operatorSubjects: ReadonlySet<string>,
        allowedOrigins: ReadonlySet<string> = new Set(),
    ) {
        if ([...operatorSubjects].some((subject) => !validSubject(subject))) {
            throw new PlatformControlPlaneError(
                "platform_configuration_invalid",
                "A Platform operator subject is invalid",
                500,
            );
        }
        if ([...allowedOrigins].some((origin) => origin !== "*" && !validOrigin(origin))) {
            throw new PlatformControlPlaneError(
                "platform_configuration_invalid",
                "A Platform browser origin is invalid",
                500,
            );
        }
        this.allowedOrigins = new Set(allowedOrigins);
        this.developerAuthenticator = developerAuthenticator;
        this.operatorSubjects = new Set(operatorSubjects);
    }
}

export class PlatformDeveloperAccess {
    readonly identity: VerifiedExternalIdentity;
    readonly role: string;
    readonly tenantId: string;

    constructor(identity: VerifiedExternalIdentity, tenantId: string, role: string) {
        this.identity = identity;
        this.tenantId = tenantId;
        this.role = role;
    }
}

export class PlatformAppCredentialAccess {
    readonly appId: string;
    readonly credentialRevision: number;
    readonly project: ProjectAccessContext;

    constructor(appId: string, credentialRevision: number, project: ProjectAccessContext) {
        this.appId = appId;
        this.credentialRevision = credentialRevision;
        this.project = project;
    }
}

export interface PlatformApplicationIdentity {
    readonly kind: "application";
    readonly tenantId: string;
    readonly appId: string;
    readonly credentialId: string;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: "all-projects" | "selected-projects";
}

export type PlatformPrincipal =
    | PlatformApplicationIdentity
    | { readonly kind: "developer"; readonly identity: VerifiedExternalIdentity };

export interface PlatformProjectPlacement {
    readonly locationHint: ProjectLocationHint;
}

export interface PlatformProjectPlacementRegistry {
    readonly resolveLocationHint: (locationHint: string) => PlatformProjectPlacement | null;
    readonly supports: (placement: PlatformProjectPlacement) => boolean;
}

export function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return true;
        }
    }
    return false;
}

function validSubject(value: string): boolean {
    return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function validOrigin(value: string): boolean {
    if (value.length === 0 || value.length > 2_048 || value === "*") {
        return false;
    }
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            parsed.origin === value &&
            parsed.username.length === 0 &&
            parsed.password.length === 0 &&
            parsed.pathname === "/" &&
            parsed.search.length === 0 &&
            parsed.hash.length === 0
        );
    } catch {
        return false;
    }
}
