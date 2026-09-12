import { isAbsolute, join } from "node:path";

import { type ResolvedExecutable, resolveExecutablePath } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";

export async function resolveUserLocalExecutable(
    executableName: string,
    context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
    context.signal.throwIfAborted();
    const platform = context.platform ?? process.platform;
    const homeDirectory = context.environment["HOME"];
    if (platform === "win32" || homeDirectory === undefined || !isAbsolute(homeDirectory)) {
        return [];
    }
    const executable = await resolveExecutablePath(join(homeDirectory, ".local", "bin", executableName), platform);
    context.signal.throwIfAborted();
    return executable === null ? [] : [executable];
}
