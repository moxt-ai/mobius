import { expect } from "vitest";
import {
    type ProductionMobiusCli,
    type StandaloneDeployment,
    startProductionMobiusCli,
    startStandaloneDeployment,
} from "../../../e2e/support/standalone.ts";
import {
    MobiusClient,
    MobiusPermissionResponseRequest,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

const defaultPrompt = fakeProviderPrompts.successfulTool;

export class AgentDaemonJourney implements AsyncDisposable {
    readonly client: MobiusClient;
    readonly daemon: ProductionMobiusCli;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly prompt: string;
    readonly #deployment: StandaloneDeployment;

    constructor(
        client: MobiusClient,
        daemon: ProductionMobiusCli,
        sessionId: string,
        signal: AbortSignal,
        prompt: string,
        deployment: StandaloneDeployment,
    ) {
        this.client = client;
        this.daemon = daemon;
        this.sessionId = sessionId;
        this.signal = signal;
        this.prompt = prompt;
        this.#deployment = deployment;
    }

    async messages(signal = AbortSignal.timeout(5_000)): Promise<readonly unknown[]> {
        return (await this.client.sessions.readMessages(this.sessionId, { cursor: "", limit: 10 }, signal)).messages;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        this.client.close();
        try {
            await this.daemon[Symbol.asyncDispose]();
        } finally {
            await this.#deployment[Symbol.asyncDispose]();
        }
    }
}

export async function startAgentDaemonJourney(options: {
    readonly agentEnvironment: Readonly<Record<string, string>>;
    readonly agentId: string;
    readonly agentPath: string;
    readonly prompt?: string;
    readonly onDiscoveryFailure?: (daemon: ProductionMobiusCli) => Promise<void> | void;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly title: string;
}): Promise<AgentDaemonJourney> {
    const deployment = await startStandaloneDeployment();
    let daemon: ProductionMobiusCli | undefined;
    let client: MobiusClient | undefined;
    try {
        const pairing = await deployment.createPairing(options.signal);
        daemon = await startProductionMobiusCli(deployment, pairing, {
            agentEnvironment: options.agentEnvironment,
            signal: options.signal,
        });
        expect(daemon.channelId).toBe(pairing.channelId);

        client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
            endpoint: deployment.origin,
            projectId: pairing.projectId,
        });
        try {
            await expect(client.runtimes.list(options.signal)).resolves.toEqual([
                expect.objectContaining({
                    agents: [
                        expect.objectContaining({
                            agentPath: options.agentPath,
                            agentVersion: expect.any(String),
                            id: options.agentId,
                        }),
                    ],
                    online: true,
                    runtimeId: pairing.runtimeId,
                }),
            ]);
        } catch (cause) {
            await options.onDiscoveryFailure?.(daemon);
            throw cause;
        }
        const session = await client.sessions.create(
            {
                agentId: options.agentId,
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: options.sessionId,
                title: options.title,
            },
            options.signal,
        );
        return new AgentDaemonJourney(
            client,
            daemon,
            session.sessionId,
            options.signal,
            options.prompt ?? defaultPrompt,
            deployment,
        );
    } catch (cause) {
        client?.close();
        try {
            await daemon?.[Symbol.asyncDispose]();
        } finally {
            await deployment[Symbol.asyncDispose]();
        }
        throw cause;
    }
}

export async function runAgentDaemonTurn(
    journey: AgentDaemonJourney,
    options: {
        readonly afterSubmit?: () => Promise<void>;
        readonly completionTimeoutMilliseconds?: number;
        readonly onEvent?: (payload: unknown) => void;
    } = {},
): Promise<void> {
    const completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
    const subscription = await journey.client.events.subscribe(
        journey.sessionId,
        "",
        {
            receive: (event) => {
                options.onEvent?.(event.payload);
                if (event.payload instanceof MobiusTurnCompletedEvent) {
                    completed.resolve(event.payload);
                }
                if (event.payload instanceof MobiusTurnFailedEvent) {
                    completed.reject(new Error(`${event.payload.code}: ${event.payload.message}`));
                }
                return Promise.resolve(true);
            },
        },
        journey.signal,
    );
    try {
        await journey.client.turns.submit(
            journey.sessionId,
            {
                additionalDirectoryIds: [],
                artifactIds: [],
                content: journey.prompt,
                idempotencyKey: journey.sessionId,
                images: [],
                resources: [],
            },
            journey.signal,
        );
        await options.afterSubmit?.();
        if (options.completionTimeoutMilliseconds === undefined) {
            await completed.promise;
        } else {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    completed.promise,
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(
                            () => reject(new Error("Timed out waiting for the Agent turn to finish")),
                            options.completionTimeoutMilliseconds,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timeout);
            }
        }
    } finally {
        subscription.close();
        await subscription.completed;
    }
}

export async function allowOneTimeToolPermission(journey: AgentDaemonJourney): Promise<void> {
    await expect
        .poll(async () => (await journey.client.interactions.listPending(journey.sessionId, journey.signal)).length, {
            timeout: 20_000,
        })
        .toBe(1);
    const [permission] = await journey.client.interactions.listPending(journey.sessionId, journey.signal);
    if (permission?.request.kind !== "permission") {
        throw new Error("Agent did not request tool permission");
    }
    const allow = permission.request.options.find((option) => option.kind === "allow_once");
    if (allow === undefined) {
        throw new Error("Agent did not offer one-time tool permission");
    }
    await journey.client.interactions.respond(
        journey.sessionId,
        permission.interactionId,
        new MobiusPermissionResponseRequest("agent-daemon-e2e", "selected", allow.optionId),
        journey.signal,
    );
}

export async function expectPersistedToolTurn(
    journey: AgentDaemonJourney,
    response: string,
    options: { readonly exactResponse?: boolean; readonly toolCount?: number } = {},
): Promise<void> {
    await expect
        .poll(
            async () => {
                const messages = await journey.messages();
                const message = messages.find(
                    (candidate): candidate is Record<string, unknown> =>
                        typeof candidate === "object" &&
                        candidate !== null &&
                        (candidate as Record<string, unknown>)["prompt"] === journey.prompt,
                );
                const activities = Array.isArray(message?.["activities"]) ? message["activities"] : [];
                const tools = activities.filter(
                    (activity) =>
                        typeof activity === "object" &&
                        activity !== null &&
                        (activity as Record<string, unknown>)["activityType"] === "tool" &&
                        (activity as Record<string, unknown>)["status"] === "completed" &&
                        typeof (activity as Record<string, unknown>)["toolCallId"] === "string",
                );
                const attempt = message?.["attempt"];
                return {
                    attemptKind:
                        typeof attempt === "object" && attempt !== null
                            ? (attempt as Record<string, unknown>)["kind"]
                            : undefined,
                    response: message?.["response"],
                    toolCount: tools.length,
                };
            },
            { timeout: 10_000 },
        )
        .toEqual({
            attemptKind: "succeeded",
            response: options.exactResponse ? response : expect.stringContaining(response),
            toolCount: options.toolCount ?? 1,
        });
}
