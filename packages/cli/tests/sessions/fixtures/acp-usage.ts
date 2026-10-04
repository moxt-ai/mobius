import * as acp from "@agentclientprotocol/sdk";
import { isRecord } from "../../support/acp-process.ts";
export async function publishUsage(context: acp.AgentRequestContext<acp.PromptRequest>): Promise<void> {
    const configuredUsage = process.env["MOBIUS_FAKE_ACP_CONTEXT_USAGE"];
    if (configuredUsage !== undefined) {
        const usage: unknown = JSON.parse(configuredUsage);
        if (
            !isRecord(usage) ||
            typeof usage["used"] !== "number" ||
            typeof usage["size"] !== "number" ||
            !isRecord(usage["cost"]) ||
            typeof usage["cost"]["amount"] !== "number" ||
            typeof usage["cost"]["currency"] !== "string"
        ) {
            throw new Error("Invalid controlled ACP context usage configuration");
        }
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                sessionUpdate: "usage_update",
                used: usage["used"],
                size: usage["size"],
                cost: { amount: usage["cost"]["amount"], currency: usage["cost"]["currency"] },
            },
        });
    }
}
export function usageResponse(): acp.PromptResponse {
    const configuredResponse = process.env["MOBIUS_FAKE_ACP_PROMPT_RESPONSE"];
    if (configuredResponse !== undefined) {
        const response: unknown = JSON.parse(configuredResponse);
        if (!isRecord(response) || (response["stopReason"] !== "end_turn" && response["stopReason"] !== "cancelled")) {
            throw new Error("Invalid controlled ACP prompt response configuration");
        }
        // Validate the envelope; deliberately malformed payload fields must reach
        // the production consumer so boundary rejection can be exercised.
        return { ...response, stopReason: response["stopReason"] };
    }
    return { stopReason: "end_turn" };
}
