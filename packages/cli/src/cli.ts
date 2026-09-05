#!/usr/bin/env node

import { formatAgentDiagnostics } from "./agent-catalog/agent-diagnostics.ts";
import { discoverLocalAgentInventory } from "./agent-catalog/discover-local-agents.ts";
import { AuditStore } from "./audit/audit-store.ts";
import { type DaemonConfig, loadApprovedRoot } from "./config.ts";
import {
  pairLocalMachine,
  resumeLocalMachine,
} from "./pairing/pair-local-machine.ts";
import { runDaemon } from "./run-daemon.ts";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

const USAGE = `Mobius CLI

Usage:
  mobius pair --url <relay-url> --code <pairing-code> --root <workspace>
  mobius start --channel <channel-id>
  mobius agents [--json]

Commands:
  pair   Pair this machine and start its local daemon
  start  Start the local daemon for a saved channel
  agents Show locally available and installable Agents
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "agents") {
    const arguments_ = process.argv.slice(3);
    if (
      arguments_.length > 1 ||
      (arguments_.length === 1 && arguments_[0] !== "--json")
    ) {
      throw new Error("Usage: mobius agents [--json]");
    }
    const inventory = await discoverLocalAgentInventory({
      approvedRoot: loadApprovedRoot(),
      environment: process.env,
      signal: shutdown.signal,
    });
    process.stdout.write(
      formatAgentDiagnostics(inventory, arguments_[0] === "--json"),
    );
    return;
  }

  let config: DaemonConfig;
  if (command === "pair") {
    const paired = await pairLocalMachine(
      process.argv.slice(3),
      shutdown.signal,
    );
    config = paired.config;
    process.stdout.write("\nLocal machine paired.\n");
    process.stdout.write(`Channel: ${paired.channelUrl}\n`);
    process.stdout.write(
      "Open this channel in any browser while the daemon is running.\n",
    );
    process.stdout.write(`Connection saved to ${paired.connectionPath}\n`);
  } else if (command === "start") {
    const paired = await resumeLocalMachine(
      process.argv.slice(3),
      shutdown.signal,
    );
    config = paired.config;
    process.stdout.write("\nSaved local machine channel loaded.\n");
    process.stdout.write(`Channel: ${paired.channelUrl}\n`);
    process.stdout.write(
      "Open this channel in any browser while the daemon is running.\n",
    );
  } else {
    throw new Error(USAGE.trimEnd());
  }

  process.stdout.write(
    "Starting the local daemon. Keep this terminal open.\n\n",
  );
  const audit = new AuditStore(config.auditDatabasePath);
  try {
    await runDaemon(config, audit, shutdown.signal);
  } finally {
    audit.close();
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
