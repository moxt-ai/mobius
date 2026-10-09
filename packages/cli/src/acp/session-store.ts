import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import { acpSessionStoreMigrations } from "../generated/acp-session-store-migrations.ts";
import { acpSession } from "../schema/acp-session-store/index.ts";

export class AcpStoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
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
    ) {
        this.additionalDirectories = [...additionalDirectories];
        this.agentId = agentId;
        this.cwd = cwd;
        this.nativeSessionId = nativeSessionId;
        this.prompted = prompted;
        this.sessionId = sessionId;
        this.title = title;
        this.updatedAt = updatedAt;
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

export interface AcpSessionStore {
    readonly close: () => void;
    readonly findNative: (agentId: string, nativeSessionId: string) => readonly AcpStoredSession[];
    readonly list: () => readonly AcpStoredSession[];
    readonly read: (sessionId: string) => AcpStoredSessionLookup;
    readonly remove: (sessionId: string) => void;
    readonly write: (session: AcpStoredSession) => void;
}

export class MemoryAcpSessionStore implements AcpSessionStore {
    readonly #sessions = new Map<string, AcpStoredSession>();

    readonly close = (): void => {
        this.#sessions.clear();
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].filter(
            (session) => session.agentId === agentId && session.nativeSessionId === nativeSessionId,
        );

    readonly list = (): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
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

const storedSessionRowSchema = z.object({
    additionalDirectories: z.string(),
    agentId: z.string(),
    cwd: z.string(),
    nativeSessionId: z.string(),
    prompted: z.boolean(),
    sessionId: z.string(),
    title: z.string(),
    updatedAt: z.string(),
});

function decodeStoredSession(value: unknown): AcpStoredSession {
    const row = storedSessionRowSchema.parse(value);
    const decodedAdditionalDirectories: unknown = JSON.parse(row.additionalDirectories);
    const additionalDirectories = z.array(z.string()).parse(decodedAdditionalDirectories);
    return new AcpStoredSession(
        row.sessionId,
        row.agentId,
        row.nativeSessionId,
        row.cwd,
        additionalDirectories,
        row.prompted,
        row.title,
        row.updatedAt,
    );
}

export class SqliteAcpSessionStore implements AcpSessionStore {
    readonly #database: NodeSQLiteDatabase;
    readonly #sqliteDatabase: DatabaseSync;

    constructor(path: string) {
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        this.#sqliteDatabase = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.#migrate();
        this.#database = drizzle({ client: this.#sqliteDatabase });
    }

    readonly #migrate = (): void => {
        const version = z
            .object({ user_version: z.number().int().nonnegative() })
            .parse(this.#sqliteDatabase.prepare("PRAGMA user_version").get()).user_version;
        if (version > acpSessionStoreMigrations.length) {
            this.#sqliteDatabase.close();
            throw new Error("The ACP Session database was created by a newer Mobius version");
        }
        for (let index = version; index < acpSessionStoreMigrations.length; index += 1) {
            const migration = acpSessionStoreMigrations[index];
            if (migration === undefined) {
                throw new Error("The ACP Session migration is unavailable");
            }
            this.#sqliteDatabase.exec("BEGIN IMMEDIATE");
            try {
                this.#sqliteDatabase.exec(migration.sql);
                this.#sqliteDatabase.exec(`PRAGMA user_version = ${index + 1}`);
                this.#sqliteDatabase.exec("COMMIT");
            } catch (error) {
                this.#sqliteDatabase.exec("ROLLBACK");
                throw error;
            }
        }
    };

    readonly close = (): void => {
        this.#sqliteDatabase.close();
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        this.#database
            .select()
            .from(acpSession)
            .where(and(eq(acpSession.agentId, agentId), eq(acpSession.nativeSessionId, nativeSessionId)))
            .all()
            .map(decodeStoredSession);

    readonly list = (): readonly AcpStoredSession[] =>
        this.#database.select().from(acpSession).orderBy(desc(acpSession.updatedAt)).all().map(decodeStoredSession);

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        const row = this.#database.select().from(acpSession).where(eq(acpSession.sessionId, sessionId)).get();
        return row === undefined ? new MissingAcpStoredSession() : new FoundAcpStoredSession(decodeStoredSession(row));
    };

    readonly remove = (sessionId: string): void => {
        this.#database.delete(acpSession).where(eq(acpSession.sessionId, sessionId)).run();
    };

    readonly write = (session: AcpStoredSession): void => {
        const value = {
            additionalDirectories: JSON.stringify(session.additionalDirectories),
            agentId: session.agentId,
            cwd: session.cwd,
            nativeSessionId: session.nativeSessionId,
            prompted: session.prompted,
            sessionId: session.sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
        };
        this.#database
            .insert(acpSession)
            .values(value)
            .onConflictDoUpdate({ target: acpSession.sessionId, set: value })
            .run();
    };
}
