import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk/protocol";
import { type AcpActivity, type AcpActivityNarration, AcpActivityTracker } from "./activity.ts";

const SESSION_CONTROL_COMMAND_ID = "session-control";

export abstract class AcpTurnState {
    abstract readonly commandId: string;
    abstract readonly running: boolean;
    abstract readonly activities: AcpActivityTracker;
    abstract readonly onText: (text: string, messageId: string) => Promise<void>;
}

export class IdleAcpTurn extends AcpTurnState {
    readonly commandId = SESSION_CONTROL_COMMAND_ID;
    readonly running = false;
    readonly activities = new AcpActivityTracker(
        () => Promise.resolve(),
        () => Promise.resolve(),
    );
    readonly onText = (): Promise<void> => Promise.resolve();
}

export class RunningAcpTurn extends AcpTurnState {
    readonly commandId: string;
    readonly running = true;
    readonly activities: AcpActivityTracker;
    readonly onText: (text: string, messageId: string) => Promise<void>;

    constructor(
        commandId: string,
        onActivity: (activity: AcpActivity) => Promise<void>,
        onNarration: ((narration: AcpActivityNarration) => Promise<void>) | undefined,
        onText: (text: string, messageId: string) => Promise<void>,
        prepareContent: (content: AgentDisplayContent) => Promise<AgentDisplayContent>,
    ) {
        super();
        this.commandId = commandId;
        this.activities = new AcpActivityTracker(onActivity, onNarration ?? (() => Promise.resolve()), prepareContent);
        this.onText = onText;
    }
}
