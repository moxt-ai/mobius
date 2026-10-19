const SESSION_CONTROL_COMMAND_ID = "session-control";

export abstract class AcpTurnState {
    abstract readonly commandId: string;
    abstract readonly running: boolean;
}

export class IdleAcpTurn extends AcpTurnState {
    readonly commandId = SESSION_CONTROL_COMMAND_ID;
    readonly running = false;
}

export class RunningAcpTurn extends AcpTurnState {
    readonly commandId: string;
    readonly running = true;

    constructor(commandId: string) {
        super();
        this.commandId = commandId;
    }
}
