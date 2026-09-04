#!/usr/bin/env node

import { AuditStore } from "./audit/audit-store.ts";
import type { DaemonConfig } from "./config.ts";
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

Commands:
  pair   Pair this machine and start its local daemon
  start  Start the local daemon for a saved channel
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  let config: DaemonConfig;
  if (command === "pair") {
    const paired = await pairLocalMachine(process.argv.slice(3));
    config = paired.config;
    process.stdout.write("\nLocal machine paired.\n");
    process.stdout.write(`Channel: ${paired.channelUrl}\n`);
    process.stdout.write(
      "Open this channel in any browser while the daemon is running.\n",
    );
    process.stdout.write(`Connection saved to ${paired.connectionPath}\n`);
  } else if (command === "start") {
    const paired = await resumeLocalMachine(process.argv.slice(3));
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
