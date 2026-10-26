import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { readStateDirectory } from "../state-directory.ts";

/** npm installs each daemon release into its own prefix, so an upgrade never overwrites the running release. */
export function releasePrefix(version: string): string {
    return join(readStateDirectory(), "npm", version);
}

/**
 * Whether `entry`, a canonical path, is the executable of a Mobius package that npm installed, which is
 * the layout `readInstalledRelease` reads, rather than a source checkout that has no release to install.
 */
export function isInstalledReleaseEntry(entry: string): boolean {
    return entry.split(sep).slice(-5).join("/") === "node_modules/@moxt-ai/mobius/dist/cli.js";
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
