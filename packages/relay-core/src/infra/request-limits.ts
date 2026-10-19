import { MAX_PROMPT_ATTACHMENT_LENGTH } from "@moxt-ai/mobius-sdk/protocol";

// Turn requests carry prompt attachments inline. Keep room beyond the protocol attachment
// budget for content, field names, configuration, and JSON framing.
export const MAX_TURN_REQUEST_BODY_LENGTH = MAX_PROMPT_ATTACHMENT_LENGTH + 1024 * 1024;
