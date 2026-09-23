import {
    MobiusAgentMessageEvent,
    MobiusClient,
    type MobiusCredentialProvider,
    MobiusPageRequest,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
} from "@moxt-ai/mobius-sdk";

export class MobiusExampleOptions {
    readonly agentId: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly endpoint: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceRef: string;
    readonly write: (text: string) => void;

    constructor(
        endpoint: string,
        projectId: string,
        runtimeId: string,
        agentId: string,
        workspaceRef: string,
        credentialProvider: MobiusCredentialProvider,
        write: (text: string) => void,
    ) {
        this.agentId = agentId;
        this.credentialProvider = credentialProvider;
        this.endpoint = endpoint;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceRef = workspaceRef;
        this.write = write;
    }
}

export class MobiusExampleResult {
    readonly messageCount: number;
    readonly sessionId: string;
    readonly turnId: string;
    readonly turnState: string;

    constructor(sessionId: string, turnId: string, turnState: string, messageCount: number) {
        this.messageCount = messageCount;
        this.sessionId = sessionId;
        this.turnId = turnId;
        this.turnState = turnState;
    }
}

export async function runMobiusExample(
    options: MobiusExampleOptions,
    signal: AbortSignal,
): Promise<MobiusExampleResult> {
    const client = new MobiusClient({
        credentialProvider: options.credentialProvider,
        endpoint: options.endpoint,
        projectId: options.projectId,
    });
    const sessionId = crypto.randomUUID();
    try {
        await client.capabilities.read(signal);
        const session = await client.sessions.create(
            {
                agentId: options.agentId,
                bindingId: crypto.randomUUID(),
                directoryId: options.workspaceRef,
                policy: new MobiusRecordingPolicy("full", 30 * 24 * 60 * 60 * 1_000, 1_000, 6_000_000),
                runtimeId: options.runtimeId,
                sessionId,
                title: "Mobius SDK example",
            },
            signal,
        );
        const subscription = await client.events.subscribe(
            session.sessionId,
            "",
            {
                receive: async (event) => {
                    if (event.payload instanceof MobiusAgentMessageEvent) {
                        options.write(event.payload.text);
                    }
                    return !(
                        event.payload instanceof MobiusTurnCompletedEvent ||
                        event.payload instanceof MobiusTurnFailedEvent
                    );
                },
            },
            signal,
        );
        const accepted = await client.turns.submit(
            session.sessionId,
            {
                additionalDirectoryIds: [],
                content: "Inspect this workspace and summarize its architecture.",
                idempotencyKey: crypto.randomUUID(),
                images: [],
                resources: [],
            },
            signal,
        );
        await subscription.completed;
        const outcome = await client.turns.read(session.sessionId, accepted.turnId, signal);
        const history = await client.sessions.readMessages(session.sessionId, new MobiusPageRequest(50, ""), signal);
        return new MobiusExampleResult(session.sessionId, outcome.turnId, outcome.state.kind, history.messages.length);
    } finally {
        client.close();
    }
}
