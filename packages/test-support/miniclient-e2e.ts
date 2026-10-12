import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPlatform } from "../cli/tests/support/platform.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const reportPath = join(root, ".vitest-reports", "mini-client-recording-e2e.json");

async function main() {
    const state = await mkdtemp(join(tmpdir(), "mobius-mini-e2e-"));
    const platform = await startTestPlatform();
    const commands: Array<{ command: string; code: number; stderr: string; stdout: string }> = [];
    function run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
            });
            child.once("error", reject);
            child.once("exit", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
        });
    }
    async function mini(name: string, args: readonly string[] = []) {
        const result = await run("pnpm", [
            "exec",
            "tsx",
            "packages/mini-client/index.ts",
            "--state-dir",
            state,
            name,
            ...args,
        ]);
        commands.push({
            command: [name, ...args].join(" ").replace(/--app-secret(?:=|\s+)\S+/gu, "--app-secret=<redacted>"),
            stderr: result.stderr.replace(/mapp_[A-Za-z0-9_-]+/gu, "<redacted>"),
            stdout: result.stdout.replace(/mapp_[A-Za-z0-9_-]+/gu, "<redacted>"),
            code: result.code,
        });
        return result;
    }
    try {
        await platform.developer.writeAppRecordingPolicy(platform.appId, "enabled", AbortSignal.timeout(20_000));
        const created = await mini("create", [
            "--app-id",
            platform.appId,
            "--app-secret",
            platform.appCredential,
            "--endpoint",
            platform.baseUrl,
        ]);
        if (created.code !== 0) {
            throw new Error(`create failed: ${created.stderr}`);
        }
        await mini("status");
        await mini("list-runtimes");
        const sessionResult = await mini("create-session", ["--agent=codex", "--title=Mini Client Recording E2E"]);
        if (sessionResult.code !== 0) {
            throw new Error(`create-session failed: ${sessionResult.stderr}`);
        }
        const session = JSON.parse(sessionResult.stdout).sessionId as string;
        await mini("get-agent-configuration", ["--session", session]);
        const prompt = await mini("send-prompt", ["--session", session, "--prompt=Reply with exactly OK and stop."]);
        if (prompt.code !== 0) {
            throw new Error(`send-prompt failed: ${prompt.stderr}`);
        }
        await mini("get", ["--session", session]);
        await mini("recording-resolve", ["--session", session]);
        await mini("recording-metadata", ["--session", session]);
        await mini("recording-integrity", ["--session", session]);
        await mini("recording-delivery", ["--session", session]);
        await mini("recording-history", ["--session", session]);
        await mini("recording-events", ["--session", session]);
        await mini("recording-export", ["--session", session]);
        await mini("recording-list", ["--limit=10"]);
        await mini("recording-retention", ["--session", session]);
        await mini("recording-retention", ["--session", session, "--retention-ms=60000"]);
        await mini("recording-delete", ["--session", session]);
        await mini("stop");
        const failed = commands.filter((entry) => entry.code !== 0);
        await mkdir(join(root, ".vitest-reports"), { recursive: true });
        await writeFile(
            reportPath,
            `${JSON.stringify({ state, baseUrl: platform.baseUrl, commands, failed }, null, 2)}\n`,
            { mode: 0o600 },
        );
        if (failed.length > 0) {
            throw new Error(`${failed.length} Mini Client commands failed`);
        }
    } finally {
        await platform.close();
        await rm(state, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
