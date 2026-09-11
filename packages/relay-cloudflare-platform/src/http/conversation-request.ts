import { ConversationAccessError } from "@moxt-ai/mobius-relay-core";

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
