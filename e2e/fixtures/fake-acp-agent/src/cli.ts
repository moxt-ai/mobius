#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";

import { FAKE_ACP_AGENT_NAME } from "./index.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPromptText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  let text = "";
  for (const block of value) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access here.
    if (!isRecord(block) || block["type"] !== "text") {
      continue;
    }
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access here.
    const blockText = block["text"];
    if (typeof blockText === "string") {
      text += blockText;
    }
  }
  return text;
}

function readAgentName(): string {
  const optionIndex = process.argv.indexOf("--agent-name");
  if (optionIndex < 0) {
    return "";
  }
  return process.argv[optionIndex + 1] ?? "";
}

function readableWebStream(
  input: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: unknown) => {
        if (!streamOpen) {
          return;
        }
        if (chunk instanceof Uint8Array) {
          controller.enqueue(new Uint8Array(chunk));
          return;
        }
        streamOpen = false;
        controller.error(new Error("ACP stdin produced a non-binary chunk"));
      });
      input.once("end", () => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.close();
      });
      input.once("error", (error) => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.error(error);
      });
    },
    cancel() {
      streamOpen = false;
    },
  });
}

function writableWebStream(
  output: NodeJS.WritableStream,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        output.write(chunk, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const sessions = new Set<string>();
const turnCounts = new Map<string, number>();
const turnCancellations = new Map<string, AbortController>();
const agentName = readAgentName();
const stream = acp.ndJsonStream(
  writableWebStream(process.stdout),
  readableWebStream(process.stdin),
);

acp
  .agent({ name: FAKE_ACP_AGENT_NAME })
  .onRequest(acp.methods.agent.initialize, () => ({
    agentCapabilities: {
      loadSession: false,
    },
    protocolVersion: acp.PROTOCOL_VERSION,
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);
    turnCounts.set(sessionId, 0);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (!sessions.has(context.params.sessionId)) {
      throw new Error("Unknown ACP session");
    }

    context.signal.throwIfAborted();
    const prompt = readPromptText(context.params.prompt);
    const turnNumber = (turnCounts.get(context.params.sessionId) ?? 0) + 1;
    turnCounts.set(context.params.sessionId, turnNumber);
    const cancellation = new AbortController();
    turnCancellations.set(context.params.sessionId, cancellation);
    try {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          _meta: { codex: { phase: "commentary" } },
          content: {
            text: "Gathering context",
            type: "text",
          },
          messageId: `progress-${turnNumber.toString()}`,
          sessionUpdate: "agent_message_chunk",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          content: {
            text: "Inspecting ",
            type: "text",
          },
          messageId: `reasoning-${turnNumber.toString()}`,
          sessionUpdate: "agent_thought_chunk",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          content: {
            text: "the workspace",
            type: "text",
          },
          messageId: `reasoning-${turnNumber.toString()}`,
          sessionUpdate: "agent_thought_chunk",
        },
      });
      if (prompt === "wait until cancelled") {
        await waitForAbort(cancellation.signal);
        return { stopReason: "cancelled" };
      }
      const toolCallId = `tool-${turnNumber.toString()}`;
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          kind: "read",
          locations: [{ path: `${process.cwd()}/package.json` }],
          name: "read_file",
          rawInput: { path: "package.json" },
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "Read package metadata",
          toolCallId,
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          rawOutput: { name: "mobius-workspace" },
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId,
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          content: {
            text:
              agentName.length === 0
                ? "Echo from ACP: "
                : `${agentName} turn ${turnNumber.toString()}: `,
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          content: {
            text: prompt,
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      });

      return { stopReason: "end_turn" };
    } finally {
      turnCancellations.delete(context.params.sessionId);
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    turnCancellations.get(context.params.sessionId)?.abort();
  })
  .connect(stream);
