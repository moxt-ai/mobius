import { z } from "zod";
import type { AcpSessionRow, AcpSessionTable } from "../../storage/session/acp-session-table.ts";
import { MemorySessionEventStore, type SessionEventStore } from "../history/session-event-store.ts";
import { decodeStoredSessionConfigurations, type StoredSessionConfiguration } from "../live/session-configurations.ts";

export class StoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly configurations: readonly StoredSessionConfiguration[];
    readonly cwd: string;
    readonly nativeSessionId: string;
    readonly prompted: boolean;
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt: string;

    constructor(
        sessionId: string,
        agentId: string,
        nativeSessionId: string,
        cwd: string,
        additionalDirectories: readonly string[],
        prompted: boolean,
        title: string,
        updatedAt = new Date().toISOString(),
        configurations: readonly StoredSessionConfiguration[] = [],
    ) {
        this.additionalDirectories = [...additionalDirectories];
        this.agentId = agentId;
        this.cwd = cwd;
        this.configurations = configurations.map((configuration) => ({ ...configuration }));
        this.nativeSessionId = nativeSessionId;
        this.prompted = prompted;
        this.sessionId = sessionId;
        this.title = title;
        this.updatedAt = updatedAt;
    }
}

export abstract class StoredSessionLookup {
    abstract readonly found: boolean;
}

export class MissingStoredSession extends StoredSessionLookup {
    readonly found = false;
}

export class FoundStoredSession extends StoredSessionLookup {
    readonly found = true;
    readonly session: StoredSession;

    constructor(session: StoredSession) {
        super();
        this.session = session;
    }
}

export interface SessionStore {
    readonly close: () => void;
    readonly events: SessionEventStore;
    readonly findNative: (agentId: string, nativeSessionId: string) => readonly StoredSession[];
    readonly list: () => readonly StoredSession[];
    readonly read: (sessionId: string) => StoredSessionLookup;
    readonly remove: (sessionId: string) => void;
    readonly write: (session: StoredSession) => void;
}

export class MemorySessionStore implements SessionStore {
    readonly events: SessionEventStore;
    readonly #sessions = new Map<string, StoredSession>();

    constructor(events: SessionEventStore = new MemorySessionEventStore()) {
        this.events = events;
    }

    readonly close = (): void => {
        this.#sessions.clear();
        this.events.close();
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly StoredSession[] =>
        [...this.#sessions.values()].filter(
            (session) => session.agentId === agentId && session.nativeSessionId === nativeSessionId,
        );

    readonly list = (): readonly StoredSession[] =>
        [...this.#sessions.values()].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    readonly read = (sessionId: string): StoredSessionLookup => {
        const session = this.#sessions.get(sessionId);
        return session === undefined ? new MissingStoredSession() : new FoundStoredSession(session);
    };

    readonly remove = (sessionId: string): void => {
        this.#sessions.delete(sessionId);
        this.events.remove(sessionId);
    };

    readonly write = (session: StoredSession): void => {
        this.#sessions.set(session.sessionId, session);
    };
}

function decodeStoredSession(row: AcpSessionRow): StoredSession {
    const decodedAdditionalDirectories: unknown = JSON.parse(row.additionalDirectories);
    const additionalDirectories = z.array(z.string()).parse(decodedAdditionalDirectories);
    const decodedConfigurations: unknown = JSON.parse(row.configurations);
    const configurations = decodeStoredSessionConfigurations(decodedConfigurations);
    return new StoredSession(
        row.sessionId,
        row.agentId,
        row.nativeSessionId,
        row.cwd,
        additionalDirectories,
        row.prompted,
        row.title,
        row.updatedAt,
        configurations,
    );
}

export class SqliteSessionStore implements SessionStore {
    readonly events: SessionEventStore;
    readonly #table: AcpSessionTable;

    constructor(table: AcpSessionTable, events: SessionEventStore = new MemorySessionEventStore()) {
        this.events = events;
        this.#table = table;
    }

    readonly close = (): void => {
        try {
            this.#table.close();
        } finally {
            this.events.close();
        }
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly StoredSession[] =>
        this.#table.findNative(agentId, nativeSessionId).map(decodeStoredSession);

    readonly list = (): readonly StoredSession[] => this.#table.list().map(decodeStoredSession);

    readonly read = (sessionId: string): StoredSessionLookup => {
        const row = this.#table.read(sessionId);
        return row === undefined ? new MissingStoredSession() : new FoundStoredSession(decodeStoredSession(row));
    };

    readonly remove = (sessionId: string): void => {
        this.#table.remove(sessionId);
        this.events.remove(sessionId);
    };

    readonly write = (session: StoredSession): void => {
        this.#table.upsert({
            additionalDirectories: JSON.stringify(session.additionalDirectories),
            agentId: session.agentId,
            configurations: JSON.stringify(session.configurations),
            cwd: session.cwd,
            nativeSessionId: session.nativeSessionId,
            prompted: session.prompted,
            sessionId: session.sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
        });
    };
}
