import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../../../packages/cli/src/cli.ts", import.meta.url));

function runCli(arguments_: readonly string[]): Readonly<{
    status: number | null;
    stderr: string;
    stdout: string;
}> {
    const result = spawnSync(process.execPath, [cliPath, ...arguments_], {
        encoding: "utf8",
        timeout: 5_000,
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

describe("Mobius CLI commands", () => {
    it("Given the CLI, when a user requests pair-list help, then it describes that command", () => {
        const result = runCli(["pair", "list", "--help"]);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Usage: mobius pair list [options]");
        expect(result.stdout).toContain("--output-json <existing-file.json>");
    });
});
