import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    const configured = environment["MOBIUS_STATE_DIRECTORY"]?.trim();
    if (configured !== undefined && configured.length > 0) {
        return resolve(configured);
    }
    return join(homedir(), ".mobius");
}
