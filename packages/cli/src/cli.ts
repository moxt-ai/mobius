#!/usr/bin/env node

import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };

import { formatAgentDiagnostics } from "./agent-catalog/agent-diagnostics.ts";
import { discoverLocalAgentInventory } from "./agent-catalog/discover-local-agents.ts";
import { DaemonLocalContext, loadDefaultWorkspace } from "./config.ts";
import { type ManagedRuntimeSummary, requestManager, runManager } from "./daemon-manager.ts";
import { openMobiusCliInstallation } from "./pairing/pair-local-machine.ts";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

const USAGE = `Mobius CLI

Usage:
  mobius --version
  mobius pair --url <relay-url> --pairing <runtime-pairing-id> --code <pairing-code> [--workspace <directory>]
  mobius pair list [--output-json=<existing-file.json>]
  mobius pair stop --connection <connection-id>
  mobius pair remove --connection <connection-id>
  mobius start --connection <connection-id>
  mobius quit
  mobius agents [--json]

Commands:
  --version  Print the installed Mobius CLI version
  pair   Pair this machine or list, stop, and remove managed pairings
  start  Start the manager and activate a saved connection
  quit   Stop the manager and every active Runtime
  agents Show detected, missing, and integration-ready Agents

Pairing grants this browser access to the machine with your user account's permissions.
New conversations default to this Mobius installation's private workspace; choose other directories in the browser.
`;

function formatPairTable(pairs: readonly ManagedRuntimeSummary[]): string {
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

function pairListOutputPath(arguments_: readonly string[]): string | null {
    if (arguments_.length === 0) {
        return null;
    }
    const prefix = "--output-json=";
    const option = arguments_.length === 1 ? arguments_[0] : undefined;
    if (option === undefined || !option.startsWith(prefix) || option.length === prefix.length) {
        throw new Error("Usage: mobius pair list [--output-json=<existing-file.json>]");
    }
    return resolve(option.slice(prefix.length));
}

async function writePairList(path: string, pairs: readonly ManagedRuntimeSummary[]): Promise<void> {
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

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === undefined || command === "--help" || command === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    if (command === "--version" || command === "-v" || command === "version") {
        process.stdout.write(`${packageMetadata.version}\n`);
        return;
    }

    if (command === "agents") {
        const arguments_ = process.argv.slice(3);
        if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--json")) {
            throw new Error("Usage: mobius agents [--json]");
        }
        const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
        const localContext = new DaemonLocalContext(installation.stateDirectory, process.env);
        const defaultWorkspace = loadDefaultWorkspace(localContext.environment);
        await mkdir(defaultWorkspace, { recursive: true, mode: 0o700 });
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace,
            environment: localContext.environment,
            signal: shutdown.signal,
        });
        process.stdout.write(formatAgentDiagnostics(inventory, arguments_[0] === "--json"));
        return;
    }

    const installation = await openMobiusCliInstallation(shutdown.signal, process.env);
    if (command === "__manager") {
        await runManager(installation, packageMetadata.version, shutdown.signal);
        return;
    }

    if (command === "pair") {
        if (process.argv[3] === "list") {
            const outputPath = pairListOutputPath(process.argv.slice(4));
            const response = await requestManager(
                installation,
                packageMetadata.version,
                { kind: "list" },
                shutdown.signal,
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (response.kind !== "listed") {
                throw new Error("The Mobius manager returned an unexpected response");
            }
            if (outputPath === null) {
                process.stdout.write(formatPairTable(response.pairs));
            } else {
                await writePairList(outputPath, response.pairs);
            }
            return;
        }
        const pairAction = process.argv[3];
        if (pairAction === "stop" || pairAction === "remove") {
            if (process.argv.length !== 6 || process.argv[4] !== "--connection" || process.argv[5] === undefined) {
                throw new Error(`Usage: mobius pair ${pairAction} --connection <connection-id>`);
            }
            const response = await requestManager(
                installation,
                packageMetadata.version,
                {
                    connectionId: process.argv[5],
                    kind: pairAction === "stop" ? "stop-pair" : "remove-pair",
                },
                shutdown.signal,
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (pairAction === "stop" && response.kind === "pair-stopped") {
                process.stdout.write(`Pairing stopped: ${response.pair.connectionId}\n`);
                return;
            }
            if (pairAction === "remove" && response.kind === "pair-removed") {
                process.stdout.write(`Pairing removed: ${response.connectionId}\n`);
                return;
            }
            throw new Error("The Mobius manager returned an unexpected response");
        }
        process.stdout.write(`mobius version: ${packageMetadata.version}\n`);
        const response = await requestManager(
            installation,
            packageMetadata.version,
            { arguments: process.argv.slice(3), kind: "pair" },
            shutdown.signal,
        );
        if (response.kind === "error") {
            throw new Error(response.message);
        }
        if (response.kind !== "ready") {
            throw new Error("The Mobius manager returned an unexpected response");
        }
        process.stdout.write(
            response.alreadyOnline ? "\nThis pairing is already online.\n" : "\nLocal machine paired.\n",
        );
        process.stdout.write(`App ID: ${response.pair.appId}\n`);
        process.stdout.write(`Connection ID: ${response.pair.connectionId}\n`);
        process.stdout.write(`Status: ${response.pair.status}\n`);
        process.stdout.write("Mobius daemon is ready for Agent requests.\n");
    } else if (command === "start") {
        const response = await requestManager(
            installation,
            packageMetadata.version,
            { arguments: process.argv.slice(3), kind: "start" },
            shutdown.signal,
        );
        if (response.kind === "error") {
            throw new Error(response.message);
        }
        if (response.kind !== "ready") {
            throw new Error("The Mobius manager returned an unexpected response");
        }
        process.stdout.write("\nSaved local Runtime connection loaded.\n");
        process.stdout.write(`Connection ID: ${response.pair.connectionId}\n`);
        process.stdout.write(`Status: ${response.pair.status}\n`);
        process.stdout.write("Mobius daemon is ready for Agent requests.\n");
    } else if (command === "quit") {
        if (process.argv.length !== 3) {
            throw new Error("Usage: mobius quit");
        }
        const response = await requestManager(installation, packageMetadata.version, { kind: "stop" }, shutdown.signal);
        if (response.kind === "error") {
            throw new Error(response.message);
        }
        process.stdout.write("Mobius daemon stopped.\n");
        return;
    } else {
        throw new Error(USAGE.trimEnd());
    }
}

try {
    await main();
} catch (error) {
    if (!shutdown.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unknown failure";
        process.stderr.write(`Mobius daemon failed: ${message}\n`);
        process.exitCode = 1;
    }
}
