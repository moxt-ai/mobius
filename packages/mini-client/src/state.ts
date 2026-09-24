import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { MiniClientError } from "./errors.ts";

const sessionSchema = v.pipe(
    v.strictObject({
        additionalDirectoryIds: v.pipe(v.array(v.string()), v.readonly()),
        agentId: v.string(),
        bindingId: v.string(),
        directoryId: v.string(),
        sessionId: v.string(),
        turns: v.pipe(
            v.array(v.pipe(v.strictObject({ prompt: v.string(), turnId: v.string() }), v.readonly())),
            v.readonly(),
        ),
    }),
    v.readonly(),
);

const commonState = {
    appId: v.string(),
    appSecret: v.string(),
    connectionId: v.string(),
    endpoint: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
    sessions: v.pipe(v.array(sessionSchema), v.readonly()),
    version: v.literal(1),
    workspace: v.string(),
};

const stateSchema = v.variant("lifecycle", [
    v.pipe(v.strictObject({ ...commonState, lifecycle: v.literal("online") }), v.readonly()),
    v.pipe(v.strictObject({ ...commonState, lifecycle: v.literal("stopped") }), v.readonly()),
]);

export type MiniClientState = v.InferOutput<typeof stateSchema>;
export type MiniClientSession = v.InferOutput<typeof sessionSchema>;

function statePath(directory: string): string {
    return join(directory, "state.json");
}

export async function prepareStateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new MiniClientError("invalid_state_directory", "The state directory must be a real directory");
    }
}

export async function requireFreshState(directory: string): Promise<void> {
    await prepareStateDirectory(directory);
    try {
        await lstat(statePath(directory));
        throw new MiniClientError("state_exists", "The state directory already contains a mini-client");
    } catch (cause) {
        if (cause instanceof MiniClientError) {
            throw cause;
        }
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
            throw cause;
        }
    }
}

export async function readState(directory: string): Promise<MiniClientState> {
    await prepareStateDirectory(directory);
    let file: FileHandle | undefined;
    try {
        file = await open(statePath(directory), constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await file.stat();
        if (!metadata.isFile()) {
            throw new MiniClientError("invalid_state", "The mini-client state is not a regular file");
        }
        const decoded: unknown = JSON.parse(await file.readFile("utf8"));
        return v.parse(stateSchema, decoded);
    } catch (cause) {
        if (cause instanceof MiniClientError) {
            throw cause;
        }
        throw new MiniClientError("invalid_state", "The mini-client state could not be read", { cause });
    } finally {
        await file?.close();
    }
}

export async function writeState(directory: string, state: MiniClientState): Promise<void> {
    await prepareStateDirectory(directory);
    const temporary = join(directory, `.state-${crypto.randomUUID()}.json`);
    try {
        await writeFile(temporary, `${JSON.stringify(v.parse(stateSchema, state), null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        await rename(temporary, statePath(directory));
    } finally {
        await rm(temporary, { force: true });
    }
}

export function sessionFromState(state: MiniClientState, sessionId: string): MiniClientSession {
    const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) {
        throw new MiniClientError("session_not_found", "The Session is not recorded in this mini-client state");
    }
    return session;
}

export function replaceSession(state: MiniClientState, session: MiniClientSession): MiniClientState {
    return {
        ...state,
        sessions: [...state.sessions.filter((candidate) => candidate.sessionId !== session.sessionId), session],
    };
}
