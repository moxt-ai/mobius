const SESSION_CONTROL_COMMAND_ID = "session-control";

export abstract class AgentTurnState {
    abstract readonly commandId: string;
    abstract readonly running: boolean;
}

export class IdleAgentTurn extends AgentTurnState {
    readonly commandId = SESSION_CONTROL_COMMAND_ID;
    readonly running = false;
}

export class RunningAgentTurn extends AgentTurnState {
    readonly commandId: string;
    readonly running = true;

    constructor(commandId: string) {
        super();
        this.commandId = commandId;
    }
}
