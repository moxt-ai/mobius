import * as acp from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-protocol";
import type { FakeAgentHarnessOptions, HarnessOutput, HarnessReplyPlan } from "./model.ts";

export type FakeHarnessEndpointTermination = { readonly kind: "closed" };

export interface FakeHarnessEndpoint {
    readonly terminated: Promise<FakeHarnessEndpointTermination>;
    readonly app: () => ReturnType<typeof acp.agent>;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly close: () => Promise<void>;
}

export const fakeHarnessCapabilities: SessionCapabilities = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: false,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: true,
    resumeSession: true,
    steering: true,
    unstableForkSession: false,
};

function configOptions(model: string): acp.SessionConfigOption[] {
    return [
        {
            category: "model",
            currentValue: model,
            description: "Model used by the controlled ACP harness",
            id: "model",
            name: "Model",
            options: [
                { name: "Test Small", value: "test-small" },
                { name: "Test Large", value: "test-large" },
            ],
            type: "select",
        },
    ];
}

interface ActiveReply {
    readonly prompt: string;
    readonly sessionId: string;
    readonly turnNumber: number;
    readonly send: (notification: acp.SessionNotification) => Promise<void>;
    readonly completion: PromiseWithResolvers<acp.PromptResponse>;
    readonly signal: AbortSignal;
    outputSequence: number;
}

function promptText(blocks: readonly acp.ContentBlock[]): string {
    return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

class ControlledAgentState {
    readonly #activeByPrompt = new Map<string, ActiveReply>();
    readonly #activeBySession = new Map<string, ActiveReply>();
    readonly #activeWaiters = new Map<string, Set<(active: ActiveReply) => void>>();
    readonly #models = new Map<string, string>();
    readonly #options: FakeAgentHarnessOptions;
    readonly #sessions = new Map<string, number>();

    constructor(options: FakeAgentHarnessOptions) {
        this.#options = options;
        for (const sessionId of options.nativeSessionIds ?? []) {
            this.#sessions.set(sessionId, 1);
        }
    }

    readonly turnCount = (sessionId: string): number => this.#sessions.get(sessionId) ?? 0;
    readonly rememberSession = (sessionId: string, turnCount = 0): void => {
        this.#sessions.set(sessionId, turnCount);
        if (!this.#models.has(sessionId)) {
            this.#models.set(sessionId, "test-small");
        }
    };
    readonly configuration = (sessionId: string): acp.SessionConfigOption[] =>
        configOptions(this.#models.get(sessionId) ?? "test-small");
    readonly configure = (sessionId: string, configId: string, value: string | boolean): acp.SessionConfigOption[] => {
        if (configId === "model" && (value === "test-small" || value === "test-large")) {
            this.#models.set(sessionId, value);
        }
        return this.configuration(sessionId);
    };
    readonly sessions = (): readonly { readonly sessionId: string; readonly turnCount: number }[] =>
        Array.from(this.#sessions, ([sessionId, turnCount]) => ({ sessionId, turnCount }));

    readonly start = async (
        sessionId: string,
        prompt: string,
        send: (notification: acp.SessionNotification) => Promise<void>,
        signal: AbortSignal,
    ): Promise<acp.PromptResponse> => {
        const turnNumber = this.turnCount(sessionId) + 1;
        this.rememberSession(sessionId, turnNumber);
        const completion = Promise.withResolvers<acp.PromptResponse>();
        const active: ActiveReply = {
            completion,
            outputSequence: 0,
            prompt,
            send,
            sessionId,
            signal,
            turnNumber,
        };
        this.#activeByPrompt.set(prompt, active);
        this.#activeBySession.set(sessionId, active);
        const waiters = this.#activeWaiters.get(prompt);
        if (waiters !== undefined) {
            this.#activeWaiters.delete(prompt);
            for (const resolve of waiters) {
                resolve(active);
            }
        }
        const abort = (): void => this.#finish(active, "cancelled");
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#apply(active, this.#options.reply(prompt, turnNumber, "prompt"));
            return await completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#forget(active);
        }
    };

    readonly steer = async (sessionId: string, prompt: string): Promise<Readonly<Record<string, unknown>>> => {
        const active = this.#activeBySession.get(sessionId);
        if (active === undefined) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        await this.#apply(active, this.#options.reply(prompt, active.turnNumber, "steer"));
        return { outcome: "injected" };
    };

    readonly cancel = (sessionId: string): void => {
        const active = this.#activeBySession.get(sessionId);
        if (active !== undefined) {
            this.#finish(active, "cancelled");
        }
    };

    readonly continueReply = async (prompt: string, plan: HarnessReplyPlan): Promise<void> => {
        const active = await this.#active(prompt);
        await this.#apply(active, plan);
    };

    async #active(prompt: string): Promise<ActiveReply> {
        const active = this.#activeByPrompt.get(prompt);
        if (active !== undefined) {
            return active;
        }
        const waiting = Promise.withResolvers<ActiveReply>();
        const waiters = this.#activeWaiters.get(prompt) ?? new Set<(active: ActiveReply) => void>();
        waiters.add(waiting.resolve);
        this.#activeWaiters.set(prompt, waiters);
        return await waiting.promise;
    }

    async #apply(active: ActiveReply, plan: HarnessReplyPlan): Promise<void> {
        active.signal.throwIfAborted();
        for (const output of plan.output) {
            await this.#publish(active, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(active, "end_turn");
        }
    }

    async #publish(active: ActiveReply, output: HarnessOutput): Promise<void> {
        active.outputSequence += 1;
        const id = `${active.sessionId}-${active.turnNumber.toString()}-${active.outputSequence.toString()}`;
        if (output.kind === "text") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    content: { text: output.text, type: "text" },
                    messageId: `assistant-${active.turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            };
            await active.send(notification);
            return;
        }
        if (output.kind === "file") {
            await active.send({
                sessionId: active.sessionId,
                update: {
                    content: {
                        name: output.name,
                        type: "resource_link",
                        uri: `file:///workspace/${encodeURIComponent(output.name)}`,
                    },
                    messageId: `assistant-${active.turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            });
            return;
        }
        if (output.activityType === "reasoning") {
            await active.send({
                sessionId: active.sessionId,
                update: {
                    content: { text: output.output, type: "text" },
                    messageId: id,
                    sessionUpdate: "agent_thought_chunk",
                },
            });
            return;
        }
        await active.send({
            sessionId: active.sessionId,
            update: {
                kind: "other",
                name: output.title,
                rawInput: {},
                rawOutput: output.output,
                sessionUpdate: "tool_call",
                status: "completed",
                title: output.title,
                toolCallId: id,
            },
        });
    }

    #finish(active: ActiveReply, stopReason: acp.StopReason): void {
        this.#forget(active);
        active.completion.resolve({ stopReason });
    }

    #forget(active: ActiveReply): void {
        if (this.#activeByPrompt.get(active.prompt) === active) {
            this.#activeByPrompt.delete(active.prompt);
        }
        if (this.#activeBySession.get(active.sessionId) === active) {
            this.#activeBySession.delete(active.sessionId);
        }
    }
}

class ControlledAgentEndpoint implements FakeHarnessEndpoint {
    readonly #closed = Promise.withResolvers<FakeHarnessEndpointTermination>();
    readonly #sessionIds = new Set<string>();
    readonly #state: ControlledAgentState;
    readonly #app: ReturnType<typeof acp.agent>;
    readonly terminated = this.#closed.promise;
    #isClosed = false;

    constructor(state: ControlledAgentState, agentName: string) {
        this.#state = state;
        this.#app = acp
            .agent({ name: "morty-controlled-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                _meta: { steering: { supported: true } },
                agentCapabilities: {
                    _meta: { claudeCode: { promptQueueing: true } },
                    loadSession: true,
                    promptCapabilities: { embeddedContext: true, image: true },
                    sessionCapabilities: { close: {}, list: {}, resume: {} },
                },
                agentInfo: { name: agentName, version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                this.#sessionIds.add(sessionId);
                this.#state.rememberSession(sessionId);
                return { configOptions: this.#state.configuration(sessionId), sessionId };
            })
            .onRequest(acp.methods.agent.session.load, (context) => {
                this.#sessionIds.add(context.params.sessionId);
                this.#state.rememberSession(context.params.sessionId, this.#state.turnCount(context.params.sessionId));
                return { configOptions: this.#state.configuration(context.params.sessionId) };
            })
            .onRequest(acp.methods.agent.session.resume, (context) => {
                this.#sessionIds.add(context.params.sessionId);
                return { configOptions: this.#state.configuration(context.params.sessionId) };
            })
            .onRequest(acp.methods.agent.session.setConfigOption, (context) => ({
                configOptions: this.#state.configure(
                    context.params.sessionId,
                    context.params.configId,
                    context.params.value,
                ),
            }))
            .onRequest(acp.methods.agent.session.list, (context) => ({
                sessions: this.#state
                    .sessions()
                    .filter((session) => session.turnCount > 0)
                    .map((session) => ({
                        additionalDirectories: [],
                        cwd: context.params.cwd ?? "/",
                        sessionId: session.sessionId,
                        title: `Native ${session.sessionId}`,
                        updatedAt: "2026-01-01T00:00:00Z",
                    })),
            }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                return await this.#state.start(
                    context.params.sessionId,
                    promptText(context.params.prompt),
                    async (notification) =>
                        await context.client.notify(acp.methods.client.session.update, notification),
                    context.signal,
                );
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => {
                    const params = context.params;
                    if (
                        typeof params !== "object" ||
                        params === null ||
                        !("sessionId" in params) ||
                        typeof params.sessionId !== "string" ||
                        !("prompt" in params) ||
                        !Array.isArray(params.prompt)
                    ) {
                        throw new Error("Invalid controlled Agent steering request");
                    }
                    return await this.#state.steer(params.sessionId, promptText(params.prompt));
                },
            )
            .onNotification(acp.methods.agent.session.cancel, (context) => {
                this.#state.cancel(context.params.sessionId);
            })
            .onRequest(acp.methods.agent.session.close, (context) => {
                this.#state.cancel(context.params.sessionId);
                this.#sessionIds.delete(context.params.sessionId);
                return {};
            });
    }

    readonly app = () => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        if (this.#isClosed) {
            return;
        }
        this.#isClosed = true;
        for (const sessionId of this.#sessionIds) {
            this.#state.cancel(sessionId);
        }
        this.#sessionIds.clear();
        this.#closed.resolve({ kind: "closed" });
    };
}

export function createFakeHarness(options: FakeAgentHarnessOptions) {
    const state = new ControlledAgentState(options);
    const agents = [
        { id: options.agentId ?? "codex", name: options.agentName ?? "Codex" },
        ...(options.additionalAgents ?? []),
    ];
    return {
        agents: agents.map((agent) => ({
            createEndpoint: (): FakeHarnessEndpoint => new ControlledAgentEndpoint(state, agent.name),
            id: agent.id,
            name: agent.name,
        })),
        catalog: agents.map((agent) => ({
            agentSettingsDiscovery: true,
            agentPath: `/fake-daemon/${agent.id}`,
            agentVersion: "controlled-harness",
            capabilities: fakeHarnessCapabilities,
            id: agent.id,
            label: agent.name,
            sessionTurnConfiguration: true,
        })),
        continueReply: state.continueReply,
    };
}
