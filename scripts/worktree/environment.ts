import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const environmentPath = fileURLToPath(
  new URL("../../.env.worktree", import.meta.url),
);
const portBases = new Map([
  ["MOBIUS_RELAY_PORT", 8787],
  ["MOBIUS_WEB_PORT", 5190],
]);
const firstWorktreeOffset = 1;
const managedOffsetCount =
  Math.min(...[...portBases.values()].map((base) => 65_535 - base)) + 1;

export function readWorktreeEnvironment(): Readonly<Record<string, string>> {
  if (!existsSync(environmentPath)) {
    return {};
  }

  const values = new Map<string, string>();
  for (const line of readFileSync(environmentPath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const name = match.at(1);
    const rawValue = match.at(2);
    if (name === undefined || rawValue === undefined || !portBases.has(name)) {
      continue;
    }
    if (values.has(name)) {
      throw new Error(`${name} appears more than once in .env.worktree`);
    }
    if (!/^\d+$/.test(rawValue)) {
      throw new Error(`${name} must be an integer TCP port`);
    }
    const port = Number(rawValue);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${name} must be between 1 and 65535`);
    }
    const base = portBases.get(name);
    if (
      base === undefined ||
      port - base < firstWorktreeOffset ||
      port - base >= managedOffsetCount
    ) {
      throw new Error(`${name} is outside the managed worktree range`);
    }
    values.set(name, rawValue);
  }
  if (values.size !== portBases.size) {
    throw new Error(
      ".env.worktree must define the complete Mobius port bundle",
    );
  }
  if (new Set(values.values()).size !== values.size) {
    throw new Error(
      ".env.worktree must assign a different port to each service",
    );
  }
  return Object.fromEntries(values);
}
