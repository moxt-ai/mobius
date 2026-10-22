import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../util/node-error.ts";

function controlTokenPath(stateDirectory: string): string {
    return join(stateDirectory, "manager.token");
}

/** The secret local control clients present to the daemon, created on first use with owner-only permissions. */
export async function readOrCreateControlToken(stateDirectory: string): Promise<string> {
    const path = controlTokenPath(stateDirectory);
    try {
        return (await readFile(path, "utf8")).trim();
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    const token = randomBytes(32).toString("base64url");
    try {
        await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
        return token;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw cause;
        }
        return (await readFile(path, "utf8")).trim();
    }
}
