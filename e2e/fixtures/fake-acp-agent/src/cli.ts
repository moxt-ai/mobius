#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import { FAKE_ACP_AGENT_NAME } from "./index.ts";
import { promptUsageResponse } from "./usage.ts";

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

function exitsAfterSessionCreation(): boolean {
  return process.argv.includes("--exit-after-session-creation");
}

function countPromptBlock(
  prompt: readonly acp.ContentBlock[],
  type: string,
): number {
  return prompt.filter((block) => block.type === type).length;
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

class FakeSessionState {
  readonly fastMode: boolean;
  readonly mode: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly turnCount: number;

  constructor(
    turnCount: number,
    model = "test-small",
    reasoningEffort = "medium",
    fastMode = false,
    mode = "code",
  ) {
    this.fastMode = fastMode;
    this.mode = mode;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.turnCount = turnCount;
  }

  readonly withTurnCount = (turnCount: number): FakeSessionState =>
    new FakeSessionState(
      turnCount,
      this.model,
      this.reasoningEffort,
      this.fastMode,
      this.mode,
    );

  readonly withMode = (mode: string): FakeSessionState =>
    new FakeSessionState(
      this.turnCount,
      this.model,
      this.reasoningEffort,
      this.fastMode,
      mode,
    );

  readonly withConfig = (
    configId: string,
    value: unknown,
  ): FakeSessionState => {
    if (configId === "model" && typeof value === "string") {
      return new FakeSessionState(
        this.turnCount,
        value,
        this.reasoningEffort,
        this.fastMode,
        this.mode,
      );
    }
    if (configId === "reasoning_effort" && typeof value === "string") {
      return new FakeSessionState(
        this.turnCount,
        this.model,
        value,
        this.fastMode,
        this.mode,
      );
    }
    if (configId === "fast_mode" && typeof value === "boolean") {
      return new FakeSessionState(
        this.turnCount,
        this.model,
        this.reasoningEffort,
        value,
        this.mode,
      );
    }
    throw new Error("Unknown fake ACP configuration option");
  };
}

function readPersistedState(sessionId: string): FakeSessionState {
  const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
  if (directory === undefined) {
    throw new Error("Fake ACP persistence is not configured");
  }
  const path = join(directory, `${encodeURIComponent(sessionId)}.json`);
  const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("Invalid fake ACP state");
  }
  const turnCount = Reflect.get(decoded, "turnCount");
  const model = Reflect.get(decoded, "model");
  const reasoningEffort = Reflect.get(decoded, "reasoningEffort");
  const fastMode = Reflect.get(decoded, "fastMode");
  const mode = Reflect.get(decoded, "mode");
  if (
    typeof turnCount !== "number" ||
    typeof model !== "string" ||
    typeof reasoningEffort !== "string" ||
    typeof fastMode !== "boolean" ||
    (mode !== undefined && typeof mode !== "string")
  ) {
    throw new Error("Invalid fake ACP state");
  }
  return new FakeSessionState(
    turnCount,
    model,
    reasoningEffort,
    fastMode,
    typeof mode === "string" ? mode : "code",
  );
}

function persistState(sessionId: string, state: FakeSessionState): void {
  const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
  if (directory === undefined) {
    return;
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${encodeURIComponent(sessionId)}.json`),
    JSON.stringify(state),
  );
}

function configOptions(state: FakeSessionState): acp.SessionConfigOption[] {
  return [
    {
      category: "model",
      currentValue: state.model,
      description: "Model used by the fake ACP agent",
      id: "model",
      name: "Model",
      options: [
        { name: "Test Small", value: "test-small" },
        { name: "Test Large", value: "test-large" },
      ],
      type: "select",
    },
    {
      category: "thought_level",
      currentValue: state.reasoningEffort,
      description: "Reasoning effort used by the fake ACP agent",
      id: "reasoning_effort",
      name: "Reasoning effort",
      options: [
        { name: "Low", value: "low" },
        { name: "Medium", value: "medium" },
        { name: "High", value: "high" },
      ],
      type: "select",
    },
    {
      category: "model_config",
      currentValue: state.fastMode,
      description: "Use the lower latency execution path",
      id: "fast_mode",
      name: "Fast mode",
      type: "boolean",
    },
  ];
}

function sessionModes(state: FakeSessionState): acp.SessionModeState {
  return {
    availableModes: [
      {
        description: "Make changes in the authorized workspace",
        id: "code",
        name: "Code",
      },
      {
        description: "Inspect the workspace and propose a plan",
        id: "plan",
        name: "Plan",
      },
    ],
    currentModeId: state.mode,
  };
}

const sessions = new Map<string, FakeSessionState>();
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
      loadSession: true,
      promptCapabilities: {
        embeddedContext: true,
        image: true,
      },
      sessionCapabilities: {
        additionalDirectories: {},
        close: {},
        resume: {},
      },
    },
    agentInfo: { name: "Mobius test agent", version: "1.0.0" },
    protocolVersion: acp.PROTOCOL_VERSION,
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = crypto.randomUUID();
    const state = new FakeSessionState(0);
    sessions.set(sessionId, state);
    persistState(sessionId, state);
    if (exitsAfterSessionCreation()) {
      setImmediate(() => process.exit(0));
    }
    return {
      configOptions: configOptions(state),
      modes: sessionModes(state),
      sessionId,
    };
  })
  .onRequest(acp.methods.agent.session.resume, (context) => {
    const state = readPersistedState(context.params.sessionId);
    sessions.set(context.params.sessionId, state);
    return { configOptions: configOptions(state), modes: sessionModes(state) };
  })
  .onRequest(acp.methods.agent.session.load, (context) => {
    const state = readPersistedState(context.params.sessionId);
    sessions.set(context.params.sessionId, state);
    return { configOptions: configOptions(state), modes: sessionModes(state) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
    const state = sessions.get(context.params.sessionId);
    if (state === undefined) {
      throw new Error("Unknown ACP session");
    }
    const updated = state.withConfig(
      context.params.configId,
      context.params.value,
    );
    sessions.set(context.params.sessionId, updated);
    persistState(context.params.sessionId, updated);
    return { configOptions: configOptions(updated) };
  })
  .onRequest(acp.methods.agent.session.setMode, (context) => {
    const state = sessions.get(context.params.sessionId);
    if (state === undefined) {
      throw new Error("Unknown ACP session");
    }
    if (
      !sessionModes(state).availableModes.some(
        (mode) => mode.id === context.params.modeId,
      )
    ) {
      throw new Error("Unknown fake ACP session mode");
    }
    const updated = state.withMode(context.params.modeId);
    sessions.set(context.params.sessionId, updated);
    persistState(context.params.sessionId, updated);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const previousState = sessions.get(context.params.sessionId);
    if (previousState === undefined) {
      throw new Error("Unknown ACP session");
    }

    context.signal.throwIfAborted();
    const prompt = readPromptText(context.params.prompt);
    const turnNumber = previousState.turnCount + 1;
    const state = previousState.withTurnCount(turnNumber);
    sessions.set(context.params.sessionId, state);
    persistState(context.params.sessionId, state);
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

      if (prompt === "report Codex usage" || prompt === "report Claude usage") {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            cost: { amount: 0.125 * turnNumber, currency: "USD" },
            sessionUpdate: "usage_update",
            size: 200_000,
            used: 50_000,
          },
        });
      }

      if (prompt === "exercise ACP controls") {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            availableCommands: [
              {
                description: "Review the current workspace",
                input: { hint: "optional focus" },
                name: "review",
              },
            ],
            sessionUpdate: "available_commands_update",
          },
        });
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: "ACP feature session",
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
        });
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            updatedAt: "2026-09-04T00:01:00.000Z",
          },
        });
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            cost: { amount: 0.125, currency: "USD" },
            sessionUpdate: "usage_update",
            size: 200_000,
            used: 50_000,
          },
        });
      }

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
          content:
            prompt === "exercise ACP controls"
              ? [
                  {
                    newText: "const feature = true;\n",
                    oldText: "const feature = false;\n",
                    path: `${process.cwd()}/feature.ts`,
                    type: "diff",
                  },
                  {
                    content: {
                      resource: {
                        mimeType: "text/plain",
                        text: "structured tool result",
                        uri: "resource:///tool-result.txt",
                      },
                      type: "resource",
                    },
                    type: "content",
                  },
                ]
              : undefined,
          rawOutput: { name: "mobius-workspace" },
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId,
        },
      });

      let selectedBranch = "";
      if (prompt === "exercise ACP controls") {
        const permission = await context.client.request(
          acp.methods.client.session.requestPermission,
          {
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
          },
        );
        if (permission.outcome.outcome !== "selected") {
          return { stopReason: "cancelled" };
        }

        const elicitation = await context.client.request(
          acp.methods.client.elicitation.create,
          {
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
          },
        );
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
        const elicitation = await context.client.request(
          acp.methods.client.elicitation.create,
          {
            elicitationId,
            message: "Connect the test account",
            mode: "url",
            sessionId: context.params.sessionId,
            url: `https://example.com/connect/${elicitationId}`,
          },
        );
        if (elicitation.action !== "accept") {
          return { stopReason: "cancelled" };
        }
        await context.client.notify(acp.methods.client.elicitation.complete, {
          elicitationId,
        });
      }

      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          content: {
            text:
              prompt === "exercise ACP controls"
                ? `${state.mode} ${state.model} ${state.reasoningEffort} ${state.fastMode ? "fast" : "standard"} ${selectedBranch} (${countPromptBlock(context.params.prompt, "image").toString()} image, ${countPromptBlock(context.params.prompt, "resource").toString()} resource)`
                : agentName.length === 0
                  ? "Echo from ACP: "
                  : `${agentName} turn ${turnNumber.toString()}: `,
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      });
      if (prompt !== "exercise ACP controls") {
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
      }

      return (
        promptUsageResponse(prompt, turnNumber) ?? { stopReason: "end_turn" }
      );
    } finally {
      turnCancellations.delete(context.params.sessionId);
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    turnCancellations.get(context.params.sessionId)?.abort();
  })
  .onRequest(acp.methods.agent.session.close, (context) => {
    sessions.delete(context.params.sessionId);
    return {};
  })
  .connect(stream);
