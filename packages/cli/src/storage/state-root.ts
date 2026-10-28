import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { installationPointerPath } from "../engine/storage/installation/installation-files.ts";
import { readStateDirectory } from "./state-directory.ts";
import { STATE_ROOT_LAYOUT } from "./state-root-layout.ts";

/** The configured state directory holds another root's installation data, so Mobius must not create a root there. */
export class StateRootError extends Error {
    readonly code = "state_root_is_installation_data";
    readonly owningRoot: string;

    constructor(stateDirectory: string, owningRoot: string) {
        super(
            `MOBIUS_STATE_DIRECTORY (${stateDirectory}) is Mobius installation data, not a state root. ` +
                `Use the state root that owns it: MOBIUS_STATE_DIRECTORY=${owningRoot}`,
        );
        this.name = "StateRootError";
        this.owningRoot = owningRoot;
    }
}

async function exists(path: string): Promise<boolean> {
    return await stat(path).then(
        () => true,
        () => false,
    );
}

/**
 * An installation directory sits at `<root>/installations/<application>/<id>` or, for CLI data,
 * `<root>/versions/<version>/installations/<application>/<id>`, and its application's `current.json` names it.
 */
async function owningRoot(directory: string): Promise<string | null> {
    const application = dirname(directory);
    const installations = dirname(application);
    if (basename(installations) !== STATE_ROOT_LAYOUT.installations) {
        return null;
    }
    let pointer: unknown;
    try {
        pointer = JSON.parse(await readFile(installationPointerPath(application), "utf8"));
    } catch {
        return null;
    }
    if (
        typeof pointer !== "object" ||
        pointer === null ||
        !("installationId" in pointer) ||
        pointer.installationId !== basename(directory)
    ) {
        return null;
    }
    const container = dirname(installations);
    return basename(dirname(container)) === STATE_ROOT_LAYOUT.versions ? dirname(dirname(container)) : container;
}

/**
 * Refuses a state directory that is another root's installation data, as an Agent launched by an earlier daemon
 * inherits. A directory a daemon already ran as its root keeps working: it records its version data there.
 */
export async function validateStateRoot(environment: Readonly<NodeJS.ProcessEnv>): Promise<void> {
    const directory = readStateDirectory(environment);
    if (
        (await exists(join(directory, STATE_ROOT_LAYOUT.currentData))) ||
        (await exists(join(directory, STATE_ROOT_LAYOUT.versions)))
    ) {
        return;
    }
    const root = await owningRoot(directory);
    if (root !== null) {
        throw new StateRootError(directory, root);
    }
}
