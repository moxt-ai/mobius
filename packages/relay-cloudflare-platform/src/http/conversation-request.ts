import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { ConversationAccessError } from "@moxt-ai/mobius-relay-core";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";

export function requestedProjectId(request: Request): string {
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    const url = new URL(request.url);
    let projectId = "";
    try {
        if (url.pathname.startsWith(prefix)) {
            projectId = decodeURIComponent(url.pathname.slice(prefix.length).split("/")[0] ?? "");
        }
    } catch (cause) {
        throw new PlatformControlPlaneError("invalid_request", "A valid Project ID is required", 400, { cause });
    }
    if (url.searchParams.has("project_id") || decodePlatformProjectPlacement(projectId) === null) {
        throw new PlatformControlPlaneError("invalid_request", "A valid Project ID path is required", 400);
    }
    return projectId;
}

export function bearer(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new ConversationAccessError("conversation_credential_required", "A Conversation credential is required");
    }
    const credential = authorization.slice("Bearer ".length);
    if (credential.length === 0 || credential.length > 16 * 1_024) {
        throw new ConversationAccessError("conversation_credential_required", "A Conversation credential is required");
    }
    return credential;
}
