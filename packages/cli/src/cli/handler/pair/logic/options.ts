import type { Command } from "commander";

export interface ParsedPairOptions {
    readonly code?: string;
    readonly pairing?: string;
    readonly url?: string;
    readonly workspace?: string;
}

export interface PairOptions extends ParsedPairOptions {
    readonly code: string;
    readonly url: string;
}

export interface ConnectionOptions {
    readonly connection: string;
}

export interface PairListOptions {
    readonly outputJson?: string;
}

function requireOption(value: string | undefined, flags: string, command: Command): string {
    if (value === undefined) {
        command.error(`required option '${flags}' not specified`, {
            code: "commander.missingMandatoryOptionValue",
        });
    }
    return value;
}

export function requirePairOptions(options: ParsedPairOptions, command: Command): PairOptions {
    return {
        ...options,
        code: requireOption(options.code, "--code <pairing-code>", command),
        url: requireOption(options.url, "--url <relay-url>", command),
    };
}

export function pairArguments(options: PairOptions): readonly string[] {
    return [
        "--url",
        options.url,
        "--code",
        options.code,
        ...(options.pairing === undefined ? [] : ["--pairing", options.pairing]),
        ...(options.workspace === undefined ? [] : ["--workspace", options.workspace]),
    ];
}
