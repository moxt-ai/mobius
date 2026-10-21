import { once } from "node:events";
import { createConnection } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { readableWebStream, writableWebStream } from "../support/acp-process.ts";

const control = process.env["MOBIUS_TEST_OUTPUT_CONTROL_PATH"];
if (control === undefined) {
    throw new Error("The pressure driver socket is required");
}
const active = new Map();
const agent = acp.agent({ name: "pressure-agent" });
agent.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "pressure-agent", version: "1.0.0" },
    agentCapabilities: { sessionCapabilities: { close: {} } },
}));
agent.onRequest(acp.methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }));
agent.onRequest(acp.methods.agent.session.prompt, async (context) => {
    const [phase, controlSessionId] = context.params.prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .split("|");
    const cancellation = new AbortController();
    active.set(context.params.sessionId, cancellation);
    const signal = AbortSignal.any([cancellation.signal, context.signal]);
    const socket = createConnection({ path: control, signal });
    try {
        await once(socket, "connect", { signal });
        socket.write(`${JSON.stringify({ kind: "stream", phase, sessionId: controlSessionId })}\n`);
        let buffered = "";
        const decoder = new TextDecoder();
        for await (const chunk of socket) {
            buffered += decoder.decode(chunk, { stream: true });
            for (;;) {
                const end = buffered.indexOf("\n");
                if (end < 0) {
                    break;
                }
                const command = JSON.parse(buffered.slice(0, end));
                buffered = buffered.slice(end + 1);
                if (command.kind === "finish") {
                    return { stopReason: "end_turn" };
                }
                for (let index = 0; index < command.chunks; index += 1) {
                    signal.throwIfAborted();
                    const marker = `${phase}:${command.round}:${index}:`;
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: command.messageId ?? `${phase}-${command.round}`,
                            content: { type: "text", text: marker.padEnd(command.bytes, command.pattern ?? "x") },
                        },
                    });
                }
                socket.write(
                    `${JSON.stringify({ kind: "emitted", phase, sessionId: controlSessionId, round: command.round })}\n`,
                );
            }
        }
        throw new Error("The control stream ended without a finish command");
    } catch (error) {
        if (signal.aborted) {
            return { stopReason: "cancelled" };
        }
        throw error;
    } finally {
        socket.destroy();
        active.delete(context.params.sessionId);
    }
});
agent.onNotification(acp.methods.agent.session.cancel, (context) => active.get(context.params.sessionId)?.abort());
agent.onRequest(acp.methods.agent.session.close, () => ({}));
agent.connect(acp.ndJsonStream(writableWebStream(process.stdout), readableWebStream(process.stdin)));
