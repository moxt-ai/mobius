import { join } from "node:path";
import { environmentHome } from "./environment.js";

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    return join(environmentHome(environment), ".pi", "pi-acp");
}

export function getPiAcpSessionMapPath(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    return join(getPiAcpDir(environment), "session-map.json");
}
