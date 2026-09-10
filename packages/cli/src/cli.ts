#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import packageMetadata from "../package.json" with { type: "json" };

import { formatAgentDiagnostics } from "./agent-catalog/agent-diagnostics.ts";
import { discoverLocalAgentInventory } from "./agent-catalog/discover-local-agents.ts";
import { BotMessageCommandError, executeBotMessageCommand } from "./bots/bot-message-command.ts";
import { type DaemonConfig, loadDefaultWorkspace } from "./config.ts";
import { pairLocalMachine, resumeLocalMachine } from "./pairing/pair-local-machine.ts";
import { MobiusRuntimeEngine } from "./runtime.ts";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

const USAGE = `Mobius CLI

Usage:
  mobius pair --url <relay-url> --pairing <runtime-pairing-id> --code <pairing-code> [--workspace <directory>]
  mobius start --channel <channel-id>
  mobius agents [--json]
  mobius bot message send --target <current|alias> --text <message>

Commands:
  pair   Pair this machine and start its local daemon
  start  Start the local daemon for a saved channel
  agents Show detected, missing, and integration-ready Agents
  bot    Invoke Bot-scoped actions from an active local execution

Pairing grants this browser access to the machine with your user account's permissions.
New conversations default to ~/.mobius/workspace; choose other directories in the browser.
`;

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === undefined || command === "--help" || command === "-h") {
        process.stdout.write(USAGE);
        return;
    }

    if (command === "agents") {
        const arguments_ = process.argv.slice(3);
        if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--json")) {
            throw new Error("Usage: mobius agents [--json]");
        }
        await mkdir(loadDefaultWorkspace(), { recursive: true, mode: 0o700 });
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: loadDefaultWorkspace(),
            environment: process.env,
            signal: shutdown.signal,
        });
        process.stdout.write(formatAgentDiagnostics(inventory, arguments_[0] === "--json"));
        return;
    }

    if (command === "bot") {
        if (process.argv[3] !== "message" || process.argv[4] !== "send") {
            throw new BotMessageCommandError(
                "invalid_request",
                "Usage: mobius bot message send --target <current|alias> --text <message>",
            );
        }
        const outboundMessageId = await executeBotMessageCommand(process.argv.slice(5), process.env, shutdown.signal);
        process.stdout.write(`${JSON.stringify({ outboundMessageId })}\n`);
        return;
    }

    let config: DaemonConfig;
    if (command === "pair") {
        process.stdout.write(`mobius version: ${packageMetadata.version}\n`);
        const paired = await pairLocalMachine(process.argv.slice(3), shutdown.signal);
        config = paired.config;
        process.stdout.write("\nLocal machine paired.\n");
        process.stdout.write(`Channel: ${paired.channelUrl}\n`);
        process.stdout.write("Open this channel in any browser while the daemon is running.\n");
        process.stdout.write(`Connection saved to ${paired.connectionPath}\n`);
    } else if (command === "start") {
        const paired = await resumeLocalMachine(process.argv.slice(3), shutdown.signal);
        config = paired.config;
        process.stdout.write("\nSaved local machine channel loaded.\n");
        process.stdout.write(`Channel: ${paired.channelUrl}\n`);
        process.stdout.write("Open this channel in any browser while the daemon is running.\n");
    } else {
        throw new Error(USAGE.trimEnd());
    }

    process.stdout.write("Starting the local daemon. Keep this terminal open.\n\n");
    process.stdout.write("This paired browser can use the machine with your user account's permissions.\n");
    process.stdout.write(`Default workspace: ${config.defaultWorkspace}\n\n`);
    await new MobiusRuntimeEngine(config).run(shutdown.signal);
}

try {
    await main();
} catch (error) {
    if (!shutdown.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unknown failure";
        const code = error instanceof BotMessageCommandError ? `${error.code}: ` : "";
        process.stderr.write(`Mobius daemon failed: ${code}${message}\n`);
        process.exitCode = 1;
    }
}
