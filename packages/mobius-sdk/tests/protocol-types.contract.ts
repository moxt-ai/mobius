// @ts-expect-error Validation schemas are private implementation details.
import type { ContentBlock, contentBlockSchema, PromptMetadata, PromptUsage } from "@moxt-ai/mobius-sdk/protocol";

declare const hiddenSchema: contentBlockSchema;

const content: ContentBlock = { text: "hello", type: "text" };
const usage: PromptUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const metadata: PromptMetadata = { messageId: "message-1" };

void content;
void hiddenSchema;
void metadata;
void usage;
