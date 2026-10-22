import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readStateDirectory } from "../state-directory.ts";

/** npm installs each daemon release into its own prefix, so an upgrade never overwrites the running release. */
export function releasePrefix(version: string): string {
    return join(readStateDirectory(), "npm", version);
}

export interface InstalledRelease {
    readonly manifest: string;
    readonly packageRoot: string;
}

/** The canonical directory of the Mobius package npm installed into `prefix`, and its package.json text. */
export async function readInstalledRelease(prefix: string): Promise<InstalledRelease> {
    const packageRoot = await realpath(join(prefix, "node_modules", "@moxt-ai", "mobius"));
    return { manifest: await readFile(join(packageRoot, "package.json"), "utf8"), packageRoot };
}
