import { resolve } from "node:path";
import { MiniClientError } from "./errors.ts";

export interface ParsedArguments {
    readonly command: string;
    readonly flags: ReadonlyMap<string, string>;
}

const BOOLEAN_FLAGS = new Set(["follow", "help"]);

export function parseArguments(values: readonly string[]): ParsedArguments {
    const flags = new Map<string, string>();
    let command = "";
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === undefined) {
            continue;
        }
        if (!value.startsWith("--")) {
            if (command.length > 0) {
                throw new MiniClientError("invalid_arguments", `Unexpected positional argument: ${value}`);
            }
            command = value;
            continue;
        }
        const separator = value.indexOf("=");
        const name = value.slice(2, separator < 0 ? undefined : separator);
        if (!/^[a-z][a-z0-9-]*$/u.test(name) || flags.has(name)) {
            throw new MiniClientError("invalid_arguments", `Invalid or repeated option: --${name}`);
        }
        if (separator >= 0) {
            flags.set(name, value.slice(separator + 1));
            continue;
        }
        if (BOOLEAN_FLAGS.has(name)) {
            flags.set(name, "true");
            continue;
        }
        const next = values[index + 1];
        if (next === undefined || next.startsWith("--")) {
            throw new MiniClientError("invalid_arguments", `Option --${name} requires a value`);
        }
        flags.set(name, next);
        index += 1;
    }
    return { command, flags };
}

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

export function stateDirectory(flags: ReadonlyMap<string, string>): string {
    const requested = resolve(requireFlag(flags, "state-dir"));
    if (requested === resolve("/")) {
        throw new MiniClientError("invalid_state_directory", "The filesystem root cannot be used as state directory");
    }
    return requested;
}

export function validateFlags(flags: ReadonlyMap<string, string>, allowed: ReadonlySet<string>): void {
    for (const name of flags.keys()) {
        if (name !== "state-dir" && !allowed.has(name)) {
            throw new MiniClientError("invalid_arguments", `Unsupported option: --${name}`);
        }
    }
}
