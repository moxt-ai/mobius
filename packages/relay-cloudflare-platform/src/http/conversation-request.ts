import { ConversationAccessError } from "@moxt-ai/mobius-relay-core";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";

export function requestedProjectId(request: Request): string {
    const values = new URL(request.url).searchParams.getAll("project_id");
    const projectId = values[0];
    if (values.length !== 1 || projectId === undefined || decodePlatformProjectPlacement(projectId) === null) {
        throw new PlatformControlPlaneError("invalid_request", "A valid project_id is required", 400);
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
