import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const stateRootSchema = z.string().brand<"StateRoot">();

/**
 * The directory MOBIUS_STATE_DIRECTORY names. It holds `current-data.txt`, each version's data under `versions/`, and
 * the control installation; an installation directory or a version's data directory is never a state root.
 */
export type StateRoot = z.infer<typeof stateRootSchema>;

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): StateRoot {
    const configured = environment["MOBIUS_STATE_DIRECTORY"]?.trim();
    return stateRootSchema.parse(
        configured !== undefined && configured.length > 0 ? resolve(configured) : join(homedir(), ".mobius"),
    );
}
