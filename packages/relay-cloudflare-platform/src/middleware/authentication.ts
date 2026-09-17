import { ExternalIdentityCredential } from "@moxt-ai/mobius-relay-core";
import type { MiddlewareHandler } from "hono";
import {
    hasControlCharacters,
    PlatformControlPlaneError,
    type PlatformPrincipal,
} from "../entity/platform-control-plane.ts";
import type { AppCredentialAuthenticationService } from "../service/app-credential-authentication-service.ts";
import type { PlatformControlPlaneService } from "../service/platform-control-plane-service.ts";

export interface PlatformAuthenticationEnvironment {
    readonly Bindings: {
        readonly control: PlatformControlPlaneService;
        readonly appAuthentication: AppCredentialAuthenticationService;
    };
    readonly Variables: { readonly signal: AbortSignal; readonly principal: PlatformPrincipal };
}

interface AuthenticationMethod {
    readonly accepts: (request: Request) => boolean;
    readonly middleware: MiddlewareHandler<PlatformAuthenticationEnvironment>;
}

export function developerCredential(request: Request): ExternalIdentityCredential {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new PlatformControlPlaneError(
            "developer_authentication_required",
            "Developer authentication is required",
            401,
        );
    }
    const value = authorization.slice("Bearer ".length);
    if (value.length === 0 || value.length > 16 * 1_024 || hasControlCharacters(value)) {
        throw new PlatformControlPlaneError(
            "developer_authentication_required",
            "Developer authentication is required",
            401,
        );
    }
    try {
        return new ExternalIdentityCredential(request.headers.get("x-mobius-oidc-provider") ?? "", value);
    } catch (cause) {
        throw new PlatformControlPlaneError("developer_authentication_failed", "Developer authentication failed", 401, {
            cause,
        });
    }
}

export const appCredentialAuthentication: AuthenticationMethod = {
    accepts: (request) => /^Bearer mapp_/iu.test(request.headers.get("authorization") ?? ""),
    middleware: async (context, next) => {
        if (context.req.header("x-mobius-oidc-provider") !== undefined) {
            throw new PlatformControlPlaneError("ambiguous_authentication", "Select one authentication method", 400);
        }
        const credential = context.req.header("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
        if (credential === undefined) {
            throw new PlatformControlPlaneError("app_credential_invalid", "An App credential is required", 401);
        }
        context.set("principal", await context.env.appAuthentication.authenticate(credential, context.var.signal));
        await next();
    },
};

export const developerOidcAuthentication: AuthenticationMethod = {
    accepts: (request) => request.headers.has("x-mobius-oidc-provider"),
    middleware: async (context, next) => {
        context.set("principal", {
            kind: "developer",
            identity: await context.env.control.authenticateDeveloper(
                developerCredential(context.req.raw),
                context.var.signal,
            ),
        });
        await next();
    },
};

// Selection happens before verification: failures never fall through to another method.
export function authenticateWith(
    ...methods: readonly [AuthenticationMethod, ...AuthenticationMethod[]]
): MiddlewareHandler<PlatformAuthenticationEnvironment> {
    return async (context, next) => {
        const method = methods.find((candidate) => candidate.accepts(context.req.raw));
        if (method === undefined) {
            throw new PlatformControlPlaneError("authentication_required", "A supported credential is required", 401);
        }
        return await method.middleware(context, next);
    };
}
