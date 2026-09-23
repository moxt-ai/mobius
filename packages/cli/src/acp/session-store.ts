export class AcpStoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly cwd: string;
    readonly nativeSessionId: string;
    readonly prompted: boolean;
    readonly sessionId: string;

    constructor(
        sessionId: string,
        agentId: string,
        nativeSessionId: string,
        cwd: string,
        additionalDirectories: readonly string[],
        prompted: boolean,
    ) {
        this.additionalDirectories = [...additionalDirectories];
        this.agentId = agentId;
        this.cwd = cwd;
        this.nativeSessionId = nativeSessionId;
        this.prompted = prompted;
        this.sessionId = sessionId;
    }
}

export abstract class AcpStoredSessionLookup {
    abstract readonly found: boolean;
}

export class MissingAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = false;
}

export class FoundAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = true;
    readonly session: AcpStoredSession;

    constructor(session: AcpStoredSession) {
        super();
        this.session = session;
    }
}

export class DeletedAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = false;
}

export interface AcpSessionStore {
    readonly findNative: (agentId: string, nativeSessionId: string) => readonly AcpStoredSession[];
    readonly markDeleted: (agentId: string, nativeSessionId: string) => readonly string[];
    readonly read: (sessionId: string) => AcpStoredSessionLookup;
    readonly remove: (sessionId: string) => void;
    readonly write: (session: AcpStoredSession) => void;
}

export class MemoryAcpSessionStore implements AcpSessionStore {
    readonly #sessions = new Map<string, AcpStoredSession>();
    readonly #deleted = new Set<string>();

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].filter(
            (session) => session.agentId === agentId && session.nativeSessionId === nativeSessionId,
        );

    readonly markDeleted = (agentId: string, nativeSessionId: string): readonly string[] => {
        const ids = this.findNative(agentId, nativeSessionId).map((session) => session.sessionId);
        for (const id of ids) {
            this.#sessions.delete(id);
            this.#deleted.add(id);
        }
        return ids;
    };

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        if (this.#deleted.has(sessionId)) {
            return new DeletedAcpStoredSession();
        }
        const session = this.#sessions.get(sessionId);
        return session === undefined ? new MissingAcpStoredSession() : new FoundAcpStoredSession(session);
    };

    readonly remove = (sessionId: string): void => {
        this.#sessions.delete(sessionId);
    };

    readonly write = (session: AcpStoredSession): void => {
        this.#sessions.set(session.sessionId, session);
    };
}
