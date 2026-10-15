import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { ManagedNpmPackageInstaller } from "../../src/agent-installation/managed-npm-package.ts";
import { PI_AGENT_PACKAGE } from "../../src/agent-installation/pi-managed-packages.ts";
import { runBoundedProcess } from "../../src/util/process/executable.ts";

test("Given a user installs managed Pi, When its verified executable starts, Then Pi 1.1.0 is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-managed-pi-"));
    const signal = AbortSignal.timeout(90_000);
    try {
        const root = join(directory, "agents", "pi", PI_AGENT_PACKAGE.version);
        await new ManagedNpmPackageInstaller().install(root, PI_AGENT_PACKAGE, process.env, signal);
        const executable = await new PiAgentSpecification().resolveManagedAgent(directory, process.platform, signal);
        const version = await runBoundedProcess({
            command: executable.path,
            arguments: ["--version"],
            cwd: directory,
            environment: { ...process.env, HOME: directory },
            signal,
            timeoutMilliseconds: 10_000,
        });
        expect(version.stdout.trim()).toBe("1.1.0");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
