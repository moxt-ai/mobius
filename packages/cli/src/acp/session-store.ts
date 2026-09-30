import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { acpSessionStoreMigrations } from "../generated/acp-session-store-migrations.ts";
import * as schema from "../schema/acp-session-store/index.ts";
import { acpSession, deletedAcpSession } from "../schema/acp-session-store/index.ts";

export class AcpStoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly cwd: string;
    readonly lastTerminalCommandId: string | null;
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
        lastTerminalCommandId: string | null = null,
    ) {
        this.additionalDirectories = [...additionalDirectories];
        this.agentId = agentId;
        this.cwd = cwd;
        this.lastTerminalCommandId = lastTerminalCommandId;
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

export class DeletedAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = false;
}

export interface AcpSessionStore {
    readonly close: () => void;
    readonly findNative: (agentId: string, nativeSessionId: string) => readonly AcpStoredSession[];
    readonly list: () => readonly AcpStoredSession[];
    readonly markDeleted: (agentId: string, nativeSessionId: string) => readonly string[];
    readonly read: (sessionId: string) => AcpStoredSessionLookup;
    readonly remove: (sessionId: string) => void;
    readonly write: (session: AcpStoredSession) => void;
}

export class MemoryAcpSessionStore implements AcpSessionStore {
    readonly #sessions = new Map<string, AcpStoredSession>();
    readonly #deleted = new Set<string>();

    readonly close = (): void => {
        this.#sessions.clear();
        this.#deleted.clear();
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].filter(
            (session) => session.agentId === agentId && session.nativeSessionId === nativeSessionId,
        );

    readonly list = (): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

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

const storedSessionRowSchema = z.object({
    additionalDirectories: z.string(),
    agentId: z.string(),
    cwd: z.string(),
    lastTerminalCommandId: z.string().nullable(),
    nativeSessionId: z.string(),
    prompted: z.boolean(),
    sessionId: z.string(),
    title: z.string(),
    updatedAt: z.string(),
});

const sessionIdRowSchema = z.object({ sessionId: z.string() });

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
        row.lastTerminalCommandId,
    );
}

export class SqliteAcpSessionStore implements AcpSessionStore {
    readonly #database: BetterSQLite3Database<typeof schema>;
    readonly #sqliteDatabase: Database.Database;

    constructor(path: string) {
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        this.#sqliteDatabase = new Database(path);
        chmodSync(path, 0o600);
        this.#migrate();
        this.#database = drizzle(this.#sqliteDatabase, { schema });
    }

    readonly #migrate = (): void => {
        const version = z
            .number()
            .int()
            .nonnegative()
            .parse(this.#sqliteDatabase.pragma("user_version", { simple: true }));
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
                this.#sqliteDatabase.pragma(`user_version = ${index + 1}`);
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

    readonly markDeleted = (agentId: string, nativeSessionId: string): readonly string[] => {
        const ids = this.#database
            .select({ sessionId: acpSession.sessionId })
            .from(acpSession)
            .where(and(eq(acpSession.agentId, agentId), eq(acpSession.nativeSessionId, nativeSessionId)))
            .all()
            .map((row) => sessionIdRowSchema.parse(row).sessionId);
        this.#database.transaction((transaction) => {
            transaction
                .delete(acpSession)
                .where(and(eq(acpSession.agentId, agentId), eq(acpSession.nativeSessionId, nativeSessionId)))
                .run();
            for (const id of ids) {
                transaction.insert(deletedAcpSession).values({ sessionId: id }).onConflictDoNothing().run();
            }
        });
        return ids;
    };

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        const deleted = this.#database
            .select({ sessionId: deletedAcpSession.sessionId })
            .from(deletedAcpSession)
            .where(eq(deletedAcpSession.sessionId, sessionId))
            .get();
        if (deleted !== undefined) {
            sessionIdRowSchema.parse(deleted);
            return new DeletedAcpStoredSession();
        }
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
            lastTerminalCommandId: session.lastTerminalCommandId,
            nativeSessionId: session.nativeSessionId,
            prompted: session.prompted,
            sessionId: session.sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
        };
        this.#database.transaction((transaction) => {
            transaction.delete(deletedAcpSession).where(eq(deletedAcpSession.sessionId, session.sessionId)).run();
            transaction
                .insert(acpSession)
                .values(value)
                .onConflictDoUpdate({
                    target: acpSession.sessionId,
                    set: value,
                })
                .run();
        });
    };
}
