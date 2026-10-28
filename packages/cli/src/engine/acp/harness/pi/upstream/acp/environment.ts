import { homedir } from "node:os";

export function environmentHome(environment: Readonly<NodeJS.ProcessEnv>): string {
    return environment["HOME"] ?? environment["USERPROFILE"] ?? homedir();
}
