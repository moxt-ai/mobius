import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

export async function resolveTestExecutable(name: string, overrideVariable: string): Promise<string> {
    const configured = process.env[overrideVariable];
    if (configured !== undefined) {
        const executable = resolve(configured);
        await access(executable, constants.X_OK);
        return executable;
    }
    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
        if (directory.length === 0) {
            continue;
        }
        const candidate = join(directory, process.platform === "win32" ? `${name}.exe` : name);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Keep searching PATH.
        }
    }
    throw new Error(`Real ${name} is required; set ${overrideVariable} or put ${name} on PATH`);
}
