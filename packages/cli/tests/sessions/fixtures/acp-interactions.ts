import * as acp from "@agentclientprotocol/sdk";
import { waitForFile } from "../../support/acp-process.ts";

export async function runInteractionScenario(
    context: acp.AgentRequestContext<acp.PromptRequest>,
    prompt: string,
    turnNumber: number,
    cancellation: AbortController,
): Promise<{ readonly stopReason: "cancelled" } | { readonly branch: string }> {
    let selectedBranch = "";
    if (prompt === "exercise ACP controls") {
        const permission = await context.client.request(acp.methods.client.session.requestPermission, {
            options: [
                {
                    kind: "allow_once",
                    name: "Allow once",
                    optionId: "allow-once",
                },
                {
                    kind: "reject_once",
                    name: "Reject",
                    optionId: "reject",
                },
            ],
            sessionId: context.params.sessionId,
            toolCall: {
                kind: "execute",
                status: "pending",
                title: "Run the verification command",
                toolCallId: "permission-tool",
            },
        });
        if (permission.outcome.outcome !== "selected") {
            return { stopReason: "cancelled" };
        }
        if (process.env["MOBIUS_FAKE_ACP_PAUSE_AFTER_PERMISSION"] === "1") {
            const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            if (directory === undefined) {
                throw new Error("The controlled Agent state directory is unavailable");
            }
            await waitForFile(directory, "resume-after-permission", cancellation.signal);
            if (cancellation.signal.aborted) {
                return { stopReason: "cancelled" };
            }
        }

        const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
            message: "Choose the branch to verify",
            mode: "form",
            requestedSchema: {
                properties: {
                    branch: {
                        description: "Git branch name",
                        minLength: 1,
                        title: "Branch",
                        type: "string",
                    },
                },
                required: ["branch"],
                type: "object",
            },
            sessionId: context.params.sessionId,
        });
        if (elicitation.action !== "accept") {
            return { stopReason: "cancelled" };
        }
        const branch =
            typeof elicitation.content === "object" &&
            elicitation.content !== null &&
            !Array.isArray(elicitation.content)
                ? Reflect.get(elicitation.content, "branch")
                : undefined;
        selectedBranch = typeof branch === "string" ? branch : "";
        if (process.env["MOBIUS_FAKE_ACP_PAUSE_AFTER_ELICITATION"] === "1") {
            const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            if (directory === undefined) {
                throw new Error("The controlled Agent state directory is unavailable");
            }
            await waitForFile(directory, "resume-after-elicitation", cancellation.signal);
            if (cancellation.signal.aborted) {
                return { stopReason: "cancelled" };
            }
        }

        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: {
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    mimeType: "image/png",
                    type: "image",
                },
                messageId: `image-${turnNumber.toString()}`,
                sessionUpdate: "agent_message_chunk",
            },
        });
    }
    if (prompt === "exercise URL elicitation") {
        const elicitationId = `url-${turnNumber.toString()}`;
        const elicitation = await context.client.request(acp.methods.client.elicitation.create, {
            elicitationId,
            message: "Connect the test account",
            mode: "url",
            sessionId: context.params.sessionId,
            url: `https://example.com/connect/${elicitationId}`,
        });
        if (elicitation.action !== "accept") {
            return { stopReason: "cancelled" };
        }
        await context.client.notify(acp.methods.client.elicitation.complete, {
            elicitationId,
        });
    }
    return { branch: selectedBranch };
}
