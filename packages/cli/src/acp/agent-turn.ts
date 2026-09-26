import type { AgentDisplayContent } from "@moxt-ai/mobius-protocol";
import { type AcpActivity, type AcpActivityNarration, AcpActivityTracker } from "./activity.ts";

const SESSION_CONTROL_COMMAND_ID = "session-control";

export abstract class AcpTurnState {
    #bufferedText: { readonly chunks: string[]; readonly messageId: string }[] = [];

    readonly bufferText = (text: string, messageId: string): void => {
        const previous = this.#bufferedText.at(-1);
        if (previous?.messageId === messageId) {
            previous.chunks.push(text);
        } else {
            this.#bufferedText.push({ chunks: [text], messageId });
        }
    };

    readonly flushText = async (): Promise<void> => {
        const buffered = this.#bufferedText;
        this.#bufferedText = [];
        for (const message of buffered) {
            for (const chunk of message.chunks) {
                await this.onText(chunk, message.messageId);
            }
        }
    };

    readonly recordTextAsProgress = async (): Promise<void> => {
        const buffered = this.#bufferedText;
        this.#bufferedText = [];
        for (const message of buffered) {
            for (const chunk of message.chunks) {
                await this.activities.recordNarrative("progress", message.messageId, chunk);
            }
        }
    };

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
