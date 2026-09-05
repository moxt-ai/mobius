import { open } from "node:fs/promises";
import { join } from "node:path";

const MAX_GRANT_FILE_LENGTH = 16 * 1024;
const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readGrantedAgents(
  stateDirectory: string,
): Promise<ReadonlySet<string>> {
  const path = join(stateDirectory, "installation-grants.json");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Set<string>();
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_GRANT_FILE_LENGTH ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()) ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error("The local installation grant file is not private");
    }
    const encoded = await handle.readFile({ encoding: "utf8" });
    const value: unknown = JSON.parse(encoded);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      value["version"] !== 1 ||
      !Array.isArray(value["agents"])
    ) {
      throw new Error("The local installation grant file is invalid");
    }
    const agents = new Set<string>();
    for (const candidate of value["agents"]) {
      if (
        typeof candidate !== "string" ||
        !AGENT_ID_PATTERN.test(candidate) ||
        agents.has(candidate)
      ) {
        throw new Error("The local installation grant file is invalid");
      }
      agents.add(candidate);
    }
    return agents;
  } finally {
    await handle.close();
  }
}
