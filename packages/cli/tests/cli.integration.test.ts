import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("Mobius CLI", () => {
  it("Given no running daemon, When help is requested, Then the CLI lists its daemon capabilities and exits", async () => {
    const result = await executeFile(process.execPath, [cliPath, "--help"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Mobius CLI");
    expect(result.stdout).toContain("mobius pair");
    expect(result.stdout).toContain("mobius start");
    expect(result.stdout).toContain("local daemon");
  });
});
