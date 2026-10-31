import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const stateRootSchema = z.string().brand<"StateRoot">();

/**
 * The directory MOBIUS_STATE_DIRECTORY names. It holds the shared data pointer, legacy data containers,
 * the default workspace, and the control installation. An installation directory is never a state root.
 */
export type StateRoot = z.infer<typeof stateRootSchema>;

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): StateRoot {
    const configured = environment["MOBIUS_STATE_DIRECTORY"]?.trim();
    return stateRootSchema.parse(
        configured !== undefined && configured.length > 0 ? resolve(configured) : join(homedir(), ".mobius"),
    );
}
