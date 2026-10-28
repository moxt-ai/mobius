import { chmod, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPathError } from "../filesystem/path-error.ts";
import type { PlatformSupport } from "./contracts.ts";

async function removeControlSocket(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
            throw cause;
        }
    }
}

export const posixOperations = {
    controlSocketPath: (installationHash: string) => join(tmpdir(), `mobius-${installationHash}.sock`),
    prepareControlSocket: removeControlSocket,
    secureControlSocket: async (path: string) => {
        await chmod(path, 0o600);
    },
    removeControlSocket,
    validatePathPermissions: async (path: string, directory: boolean, privateAccess: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        const metadata = await lstat(path);
        if (process.getuid === undefined || metadata.uid !== process.getuid()) {
            throw new LocalPathError("Path is not user-owned");
        }
        if (privateAccess) {
            await chmod(path, directory ? 0o700 : 0o600);
        }
        signal.throwIfAborted();
    },
} satisfies Pick<
    PlatformSupport,
    | "controlSocketPath"
    | "prepareControlSocket"
    | "secureControlSocket"
    | "removeControlSocket"
    | "validatePathPermissions"
>;
