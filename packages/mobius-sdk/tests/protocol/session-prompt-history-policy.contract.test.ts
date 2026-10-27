import {
    decodeSessionPromptCommand,
    encodeSessionPromptCommand,
    SessionHistoryPolicy,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

const prompt = {
    additionalDirectoryIds: [],
    agentId: "agent-1",
    bindingId: "binding-1",
    commandId: "command-1",
    directoryId: "directory-1",
    disposition: SessionPromptDisposition.Reject,
    attachments: [],
    kind: "session.prompt" as const,
    prompt: "continue",
    sessionId: "session-1",
    targetCommandId: "",
};

describe("Session prompt history policy", () => {
    it("preserves execution-only prompts across the Runtime command boundary", () => {
        const encoded = encodeSessionPromptCommand({
            ...prompt,
            historyPolicy: SessionHistoryPolicy.ExecutionOnly,
        });

        expect(decodeSessionPromptCommand(encoded)).toMatchObject({
            historyPolicy: SessionHistoryPolicy.ExecutionOnly,
        });
    });

    it("keeps older prompt commands on the eager policy default", () => {
        expect(decodeSessionPromptCommand(JSON.stringify(prompt))).not.toHaveProperty("historyPolicy");
    });

    it("rejects unknown history policies instead of silently replaying history", () => {
        expect(() => decodeSessionPromptCommand(JSON.stringify({ ...prompt, historyPolicy: "best-effort" }))).toThrow(
            "historyPolicy",
        );
    });
});
