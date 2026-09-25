import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MiniClientError } from "./errors.ts";

export function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
    const value = flags.get(name)?.trim();
    if (value === undefined || value.length === 0) {
        throw new MiniClientError("invalid_arguments", `Required option --${name} was not specified`);
    }
    return value;
}

export function optionalFlag(flags: ReadonlyMap<string, string>, name: string, fallback: string): string {
    const value = flags.get(name);
    return value === undefined ? fallback : value;
}

export type StateDirectorySelection =
    | { readonly kind: "generated"; readonly path: string }
    | { readonly kind: "requested"; readonly path: string };

export function stateDirectory(value: unknown, command: string): StateDirectorySelection {
    if (value === undefined) {
        if (command !== "create") {
            throw new MiniClientError("invalid_arguments", "Required option --state-dir was not specified");
        }
        return { kind: "generated", path: mkdtempSync(join(tmpdir(), "mobius-mini-client-")) };
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new MiniClientError("invalid_arguments", "Option --state-dir requires a value");
    }
    const requested = resolve(value);
    if (requested === resolve("/")) {
        throw new MiniClientError("invalid_state_directory", "The filesystem root cannot be used as state directory");
    }
    return { kind: "requested", path: requested };
}
