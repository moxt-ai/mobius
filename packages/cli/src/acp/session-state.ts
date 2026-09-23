import type {
    CreateElicitationResponse,
    ElicitationContentValue,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentDisplayContent } from "@moxt-ai/mobius-protocol";
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

export class PendingPermission {
    readonly completion = Promise.withResolvers<RequestPermissionResponse>();
    readonly interactionId: string;
    readonly optionIds: ReadonlySet<string>;
    #settled = false;

    constructor(interactionId: string, optionIds: ReadonlySet<string>) {
        this.interactionId = interactionId;
        this.optionIds = optionIds;
    }

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ outcome: { outcome: "cancelled" } });
        return true;
    };

    readonly select = (optionId: string): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({
            outcome: { optionId, outcome: "selected" },
        });
        return true;
    };
}

export class PendingElicitation {
    readonly completion = Promise.withResolvers<CreateElicitationResponse>();
    readonly elicitationId: string;
    readonly interactionId: string;
    readonly requestedSchema: unknown;
    #settled = false;

    constructor(interactionId: string, elicitationId: string, requestedSchema: unknown) {
        this.elicitationId = elicitationId;
        this.interactionId = interactionId;
        this.requestedSchema = requestedSchema;
    }

    readonly accept = (content: Readonly<Record<string, ElicitationContentValue>>): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "accept", content });
        return true;
    };

    readonly cancel = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "cancel" });
        return true;
    };

    readonly decline = (): boolean => {
        if (this.#settled) {
            return false;
        }
        this.#settled = true;
        this.completion.resolve({ action: "decline" });
        return true;
    };
}
