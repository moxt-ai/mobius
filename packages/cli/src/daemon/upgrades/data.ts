import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../control/local-client.ts";
import { readSwitchStatus } from "../control/switch-status.ts";

export class DataInheritanceError extends Error {
    readonly code = "data_inheritance_failed";
}

// A relative, version-only pointer remains valid if the state root is moved.
async function currentDataVersion(root: string, signal: AbortSignal): Promise<string | null> {
    const pointer = join(root, "current-data.txt");
    try {
        await validateLocalPath(pointer, false, true, signal);
        const value = (await readFile(pointer, { encoding: "utf8", signal })).trim();
        if (!value.startsWith("versions/")) {
            throw new DataInheritanceError("The current data pointer must name a version directory");
        }
        return runtimeUpgradeVersionSchema.parse(value.slice("versions/".length));
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw cause;
    }
}

export async function prepareVersionData(
    version: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    fallbackVersion: string | null = null,
): Promise<void> {
    signal.throwIfAborted();
    const root = readStateDirectory(environment);
    const targetVersion = runtimeUpgradeVersionSchema.parse(version);
    const versions = join(root, "versions");
    const target = join(versions, targetVersion);
    try {
        await validateLocalPath(target, true, true, signal);
        return;
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    const previous = (await currentDataVersion(root, signal)) ?? fallbackVersion;
    if (previous === null) {
        return;
    }
    const source = join(versions, runtimeUpgradeVersionSchema.parse(previous));
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(versions, true, true, signal);
    await validateLocalPath(source, true, true, signal);
    const staging = await mkdtemp(join(versions, `.${targetVersion}-`));
    try {
        await cp(source, staging, {
            recursive: true,
            filter: async (path) => {
                signal.throwIfAborted();
                if ((await lstat(path)).isSymbolicLink()) {
                    throw new DataInheritanceError("The inherited data contains a symbolic link");
                }
                return true;
            },
        });
        signal.throwIfAborted();
        try {
            await rename(staging, target);
        } catch (cause) {
            // Another CLI may have finished the same first-use copy.
            if (!isNodeError(cause, "EEXIST") && !isNodeError(cause, "ENOTEMPTY")) {
                throw cause;
            }
            await validateLocalPath(target, true, true, signal);
        }
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

export async function recordCurrentData(version: string, signal: AbortSignal): Promise<void> {
    const root = readStateDirectory();
    const value = `versions/${runtimeUpgradeVersionSchema.parse(version)}`;
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(join(root, "versions", version), true, true, signal);
    const temporary = join(root, `.current-data-${randomUUID()}.txt`);
    try {
        await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx", signal });
        signal.throwIfAborted();
        await rename(temporary, join(root, "current-data.txt"));
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function prepareUpgradeData(
    controlDirectory: string,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    const transition = await readSwitchStatus(controlDirectory, signal);
    const previous =
        transition?.kind === "switching" && transition.next.version === version ? transition.previous.version : null;
    await prepareVersionData(version, signal, process.env, previous);
}
