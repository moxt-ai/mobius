#!/usr/bin/env node

import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import packageMetadata from "../package.json" with { type: "json" };

import { formatAgentDiagnostics } from "./agent-catalog/agent-diagnostics.ts";
import { discoverLocalAgentInventory } from "./agent-catalog/discover-local-agents.ts";
import { DaemonLocalContext, loadDefaultWorkspace } from "./config.ts";
import { runManager } from "./daemon-manager.ts";
import { ensureWorkingProcess, stopManager } from "./daemon-manager-client.ts";
import { reloadDaemon, runWorker } from "./daemon-worker.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
    pairLocalMachine,
} from "./pairing/pair-local-machine.ts";
import type { VerifiedRuntimeConnection } from "./storage/runtime-installation-store.ts";

type SavedPairSummary = {
    readonly appId: string;
    readonly connectionId: string;
    readonly runtimeId: string;
    readonly status: VerifiedRuntimeConnection["activation"];
    readonly workspace: string;
};
function savedSummary(connection: VerifiedRuntimeConnection): SavedPairSummary {
    return {
        appId: connection.appId,
        connectionId: connection.connectionId,
        runtimeId: connection.runtimeId,
        workspace: connection.defaultWorkspace,
        status: connection.activation,
    };
}

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

interface ParsedPairOptions {
    readonly code?: string;
    readonly pairing?: string;
    readonly url?: string;
    readonly workspace?: string;
}

interface PairOptions extends ParsedPairOptions {
    readonly code: string;
    readonly url: string;
}

interface ConnectionOptions {
    readonly connection: string;
}

interface StartOptions {
    readonly connection?: string;
}

interface PairListOptions {
    readonly outputJson?: string;
}

function formatPairTable(pairs: readonly SavedPairSummary[]): string {
    const headers = ["connection_id", "app_id", "runtime_id", "workspace", "status"];
    const rows = pairs.map((pair) => [pair.connectionId, pair.appId, pair.runtimeId, pair.workspace, pair.status]);
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
    );
    const line = (row: readonly string[]): string =>
        `| ${row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join(" | ")} |`;
    const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
    return `${line(headers)}\n${divider}\n${rows.map(line).join("\n")}${rows.length === 0 ? "" : "\n"}`;
}

function readOnce(optionName: string): (value: string, previous: string | undefined) => string {
    return (value, previous) => {
        if (previous !== undefined) {
            throw new InvalidArgumentError(`${optionName} may only be specified once`);
        }
        return value;
    };
}

function valueOption(flags: string, description: string, mandatory = false): Option {
    const option = new Option(flags, description).argParser(readOnce(flags.split(" ")[0] ?? flags));
    return mandatory ? option.makeOptionMandatory() : option;
}

function requireOption(value: string | undefined, flags: string, command: Command): string {
    if (value === undefined) {
        command.error(`required option '${flags}' not specified`, {
            code: "commander.missingMandatoryOptionValue",
        });
    }
    return value;
}

function pairArguments(options: PairOptions): readonly string[] {
    return [
        "--url",
        options.url,
        "--code",
        options.code,
        ...(options.pairing === undefined ? [] : ["--pairing", options.pairing]),
        ...(options.workspace === undefined ? [] : ["--workspace", options.workspace]),
    ];
}

async function writePairList(path: string, pairs: readonly SavedPairSummary[]): Promise<void> {
    shutdown.signal.throwIfAborted();
    let file: FileHandle;
    try {
        file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
            throw new Error("The JSON output file does not exist", { cause });
        }
        throw new Error("The JSON output file cannot be written", { cause });
    }
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) {
            throw new Error("The JSON output path is not a regular file");
        }
        const output = pairs.map((pair) => ({
            app_id: pair.appId,
            connection_id: pair.connectionId,
            runtime_id: pair.runtimeId,
            status: pair.status,
            workspace: pair.workspace,
        }));
        shutdown.signal.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(`${JSON.stringify(output, null, 2)}\n`, "utf8");
    } finally {
        await file.close();
    }
}

function createProgram(): Command {
    const program = new Command()
        .name("mobius")
        .description("Pair and run local AI agent services.")
        .version(packageMetadata.version, "-v, --version", "print the installed Mobius CLI version")
        .showHelpAfterError()
        .exitOverride()
        .addHelpText(
            "after",
            "\nPairing grants this browser access to the machine with your user account's permissions.\nNew conversations default to this Mobius installation's private workspace; choose other directories in the browser.\n",
        );

    program.action(() => program.outputHelp());
    program
        .command("version", { hidden: true })
        .description("print the installed Mobius CLI version")
        .action(() => {
            process.stdout.write(`${packageMetadata.version}\n`);
        });

    program
        .command("agents")
        .description("show detected, missing, and integration-ready Agents")
        .option("--json", "write the Agent inventory as JSON")
        .option("--verbose", "include per-Agent detection timing")
        .action(async (options: Readonly<{ json?: boolean; verbose?: boolean }>) => {
            const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
            const localContext = new DaemonLocalContext(installation.stateDirectory, process.env);
            const defaultWorkspace = loadDefaultWorkspace(localContext.environment);
            await mkdir(defaultWorkspace, { recursive: true, mode: 0o700 });
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace,
                environment: localContext.environment,
                signal: shutdown.signal,
            });
            process.stdout.write(formatAgentDiagnostics(inventory, options.json === true, options.verbose === true));
        });

    program.command("__manager", { hidden: true }).action(async () => {
        const installation = await openMobiusControlInstallation(shutdown.signal, process.env);
        await runManager(installation.stateDirectory, shutdown.signal);
    });

    program.command("__worker", { hidden: true }).action(async () => {
        await runWorker(packageMetadata.version, shutdown.signal);
    });
    const pair = program.command("pair").description("pair this machine or manage saved pairings");
    pair.addOption(valueOption("--url <relay-url>", "relay HTTP or HTTPS URL"))
        .addOption(valueOption("--code <pairing-code>", "pairing code shown in the browser"))
        .addOption(valueOption("--pairing <runtime-pairing-id>", "Runtime pairing identifier"))
        .addOption(valueOption("--workspace <directory>", "default workspace directory"))
        .action(async (options: ParsedPairOptions) => {
            const requested: PairOptions = {
                ...options,
                code: requireOption(options.code, "--code <pairing-code>", pair),
                url: requireOption(options.url, "--url <relay-url>", pair),
            };
            const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
            process.stdout.write(`mobius version: ${packageMetadata.version}\n`);
            const paired = await pairLocalMachine(pairArguments(requested), shutdown.signal);
            const connection = await installation.setConnectionActivation(
                paired.connectionId,
                "active",
                shutdown.signal,
            );
            const control = await openMobiusControlInstallation(shutdown.signal, process.env);
            await ensureWorkingProcess(control.stateDirectory, packageMetadata.version, shutdown.signal);
            await reloadDaemon(control.stateDirectory, shutdown.signal);
            process.stdout.write(
                `\nLocal machine paired.\nApp ID: ${connection.appId}\nConnection ID: ${connection.connectionId}\n`,
            );
            process.stdout.write("Mobius daemon is running; connection will reconnect automatically.\n");
        });

    pair.command("list")
        .description("list saved pairings")
        .addOption(valueOption("--output-json <existing-file.json>", "write JSON to an existing file"))
        .action(async (options: PairListOptions) => {
            const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
            const outputPath = options.outputJson === undefined ? null : resolve(options.outputJson);
            const pairs = (await installation.listConnections(shutdown.signal))
                .map(savedSummary)
                .sort(
                    (left, right) =>
                        left.appId.localeCompare(right.appId) || left.connectionId.localeCompare(right.connectionId),
                );
            if (outputPath === null) {
                process.stdout.write(formatPairTable(pairs));
            } else {
                await writePairList(outputPath, pairs);
            }
        });

    const addPairMutation = (name: "remove" | "stop"): void => {
        pair.command(name)
            .description(`${name} a saved pairing`)
            .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier", true))
            .action(async (options: ConnectionOptions) => {
                const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
                if (name === "remove") {
                    await installation.removeConnection(options.connection, shutdown.signal);
                } else {
                    await installation.setConnectionActivation(options.connection, "stopped", shutdown.signal);
                }
                await reloadDaemon(
                    (await openMobiusControlInstallation(shutdown.signal, process.env)).stateDirectory,
                    shutdown.signal,
                );
                process.stdout.write(`Pairing ${name === "remove" ? "removed" : "stopped"}: ${options.connection}\n`);
            });
    };
    addPairMutation("stop");
    addPairMutation("remove");

    program
        .command("start")
        .description("ensure the daemon is running and optionally activate a saved connection")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier"))
        .action(async (options: StartOptions) => {
            const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
            if (options.connection !== undefined) {
                await installation.setConnectionActivation(options.connection, "active", shutdown.signal);
            }
            const control = await openMobiusControlInstallation(shutdown.signal, process.env);
            await ensureWorkingProcess(control.stateDirectory, packageMetadata.version, shutdown.signal);
            await reloadDaemon(control.stateDirectory, shutdown.signal);
            process.stdout.write("Mobius daemon is running.\n");
        });

    program
        .command("quit")
        .description("stop the manager and every active Runtime")
        .action(async () => {
            const installation = await openMobiusControlInstallation(shutdown.signal, process.env);
            await stopManager(installation.stateDirectory, shutdown.signal);
            process.stdout.write("Mobius daemon stopped.\n");
        });

    return program;
}

async function main(): Promise<void> {
    await createProgram().parseAsync(process.argv);
}

try {
    await main();
} catch (error) {
    if (error instanceof CommanderError) {
        process.exitCode = error.exitCode;
    } else if (!shutdown.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unknown failure";
        process.stderr.write(`Mobius daemon failed: ${message}\n`);
        process.exitCode = 1;
    }
}
