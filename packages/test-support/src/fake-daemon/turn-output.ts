import type * as p from "@moxt-ai/mobius-protocol";
import type { Output, Turn } from "./model.ts";

export function appendOutput(
    turn: Turn,
    sessionId: string,
    output: Output,
): { readonly turn: Turn; readonly event: p.RecordedSessionEvent } {
    const commandId = turn.commandIds[0];
    const id = crypto.randomUUID();
    let message: p.ActiveTurnMessage;
    let event: p.RecordedSessionEvent;
    let sequence = turn.sequence;
    switch (output.kind) {
        case "text":
            sequence++;
            message = { id, role: "assistant", text: output.text, activities: [], content: [] };
            event = {
                kind: "agent.message.delta",
                sessionId,
                commandId,
                epoch: turn.epoch,
                sequence,
                messageId: id,
                text: output.text,
            };
            break;
        case "file": {
            const content: p.AgentDisplayContent = {
                artifactId: "",
                data: "AQ==",
                mimeType: "application/octet-stream",
                name: output.name,
                newText: "",
                oldText: "",
                path: "",
                terminalId: "",
                text: "",
                type: "resource",
                uri: `file:///${output.name}`,
            };
            message = { id, role: "assistant", text: "", activities: [], content: [content] };
            event = { kind: "agent.content", sessionId, commandId, contentId: id, messageId: id, content };
            break;
        }
        case "activity": {
            const activity = {
                activityId: id,
                activityType: output.activityType,
                content: [],
                input: "",
                locations: [],
                name: output.title,
                output: output.output,
                sequence: 0,
                status: "completed",
                title: output.title,
                toolKind: output.activityType === "tool" ? "read" : "",
            };
            message = { id, role: "assistant", text: "", activities: [activity], content: [] };
            event = {
                ...activity,
                kind: "agent.activity",
                sessionId,
                commandId,
                detail: { kind: "recorded", content: [], input: "", output: output.output },
            };
            break;
        }
        default: {
            const unhandled: never = output;
            throw new Error(`Unhandled output ${unhandled}`);
        }
    }
    return { turn: { ...turn, sequence, messages: [...turn.messages, message] }, event };
}
