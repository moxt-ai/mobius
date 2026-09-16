import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));
const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function stopProcessTree(child: ChildProcess): void {
    if (process.platform === "win32") {
        child.kill("SIGTERM");
        return;
    }
    if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGTERM");
    }
}

function forceStopProcessTree(child: ChildProcess): void {
    if (process.platform === "win32") {
        child.kill("SIGKILL");
        return;
    }
    if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
    }
}

export interface StandalonePairing {
    readonly channelId: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePairing(value: unknown): StandalonePairing {
    if (!isRecord(value)) {
        throw new Error("The Standalone pairing response is invalid");
    }
    const pairing = {
        channelId: value["channelId"],
        hostToken: value["hostToken"],
        pairingCode: value["pairingCode"],
        projectId: value["projectId"],
        runtimeId: value["runtimeId"],
    };
    if (Object.values(pairing).some((entry) => typeof entry !== "string")) {
        throw new Error("The Standalone pairing response is incomplete");
    }
    return pairing as StandalonePairing;
}

async function reservePort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        server.close();
        throw new Error("Could not reserve an E2E port");
    }
    server.close();
    await once(server, "close");
    return address.port;
}

class ObservedProcess {
    readonly child: ChildProcess;
    #output = "";

    constructor(command: string, arguments_: readonly string[], options: Parameters<typeof spawn>[2]) {
        this.child = spawn(command, arguments_, {
            ...options,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const collect = (chunk: Buffer): void => {
            this.#output += chunk.toString();
        };
        this.child.stdout?.on("data", collect);
        this.child.stderr?.on("data", collect);
    }

    get output(): string {
        return this.#output;
    }

    async waitFor(text: string, timeoutMilliseconds: number): Promise<void> {
        if (this.#output.includes(text)) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => finish(new Error(`Process did not report ${text}\n${this.#output}`)),
                timeoutMilliseconds,
            );
            const output = (): void => {
                if (this.#output.includes(text)) {
                    finish();
                }
            };
            const exit = (): void => finish(new Error(`Process exited before reporting ${text}\n${this.#output}`));
            const finish = (error?: Error): void => {
                clearTimeout(timeout);
                this.child.stdout?.removeListener("data", output);
                this.child.stderr?.removeListener("data", output);
                this.child.removeListener("exit", exit);
                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            };
            this.child.stdout?.on("data", output);
            this.child.stderr?.on("data", output);
            this.child.once("exit", exit);
        });
    }

    async stop(): Promise<void> {
        const exited =
            this.child.exitCode === null ? once(this.child, "exit", { signal: AbortSignal.timeout(5_000) }) : null;
        try {
            stopProcessTree(this.child);
            if (exited !== null) {
                await exited;
            }
        } catch {
            if (this.child.exitCode === null) {
                const forcedExit = once(this.child, "exit");
                forceStopProcessTree(this.child);
                await forcedExit;
            }
        }
    }
}

export class StandaloneDeployment implements AsyncDisposable {
    readonly origin: string;
    readonly #process: ObservedProcess;
    readonly #temporaryDirectory: string;

    constructor(origin: string, process_: ObservedProcess, temporaryDirectory: string) {
        this.origin = origin;
        this.#process = process_;
        this.#temporaryDirectory = temporaryDirectory;
    }

    async createPairing(signal: AbortSignal): Promise<StandalonePairing> {
        const response = await fetch(new URL("/mobius/api/pairings", this.origin), { method: "POST", signal });
        if (response.status !== 201) {
            throw new Error(`Could not create a Standalone pairing: ${response.status.toString()}`);
        }
        return decodePairing(await response.json());
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#process.stop();
        await rm(this.#temporaryDirectory, { recursive: true, force: true });
    }
}

export async function startStandaloneDeployment(): Promise<StandaloneDeployment> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-e2e-relay-"));
    const port = await reservePort();
    const process_ = new ObservedProcess(
        pnpmCommand,
        ["wrangler", "dev", "--ip", "127.0.0.1", "--port", port.toString(), "--persist-to", temporaryDirectory],
        {
            cwd: repositoryRoot,
            env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        },
    );
    try {
        await process_.waitFor("Ready on http://", 30_000);
        return new StandaloneDeployment(`http://127.0.0.1:${port.toString()}`, process_, temporaryDirectory);
    } catch (cause) {
        await process_.stop();
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw cause;
    }
}

function executable(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

async function createFakeCodex(directory: string): Promise<Readonly<Record<string, string>>> {
    const bin = join(directory, "bin");
    const agent = join(bin, "codex");
    const adapter = join(bin, "codex-acp");
    const missing = join(directory, "missing-agent");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await Promise.all([
        writeFile(
            agent,
            executable(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex", "--exclusive-writer");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
            { mode: 0o700 },
        ),
        writeFile(
            adapter,
            executable(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const child = spawn(process.env.CODEX_PATH, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
            { mode: 0o700 },
        ),
    ]);
    await Promise.all([chmod(agent, 0o700), chmod(adapter, 0o700)]);
    return {
        CODEX_PATH: agent,
        MOBIUS_CODEX_PATH: agent,
        MOBIUS_CODEX_ACP_PATH: adapter,
        MOBIUS_CLAUDE_PATH: missing,
        MOBIUS_CLAUDE_ACP_PATH: missing,
        MOBIUS_COPILOT_PATH: missing,
        MOBIUS_CURSOR_PATH: missing,
        MOBIUS_DEEPSEEK_HARNESS_PATH: missing,
        MOBIUS_GEMINI_PATH: missing,
        MOBIUS_GROK_BUILD_PATH: missing,
        MOBIUS_HERMES_PATH: missing,
        MOBIUS_OPENCODE_PATH: missing,
        MOBIUS_PI_PATH: missing,
        MOBIUS_PI_ACP_PATH: missing,
        MOBIUS_WORKBUDDY_PATH: missing,
    };
}

export class ProductionMobiusCli implements AsyncDisposable {
    readonly channelId: string;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #temporaryDirectory: string;
    #process: ObservedProcess;

    constructor(
        channelId: string,
        environment: NodeJS.ProcessEnv,
        process_: ObservedProcess,
        temporaryDirectory: string,
    ) {
        this.channelId = channelId;
        this.#environment = environment;
        this.#process = process_;
        this.#temporaryDirectory = temporaryDirectory;
    }

    get output(): string {
        return this.#process.output;
    }

    async restartFromSavedChannel(): Promise<void> {
        await this.#process.stop();
        this.#process = spawnCli(["start", "--channel", this.channelId], this.#environment);
        await this.#process.waitFor("Mobius daemon connected to the relay.", 20_000);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#process.stop();
        await rm(this.#temporaryDirectory, { recursive: true, force: true });
    }
}

function spawnCli(arguments_: readonly string[], environment: NodeJS.ProcessEnv): ObservedProcess {
    return new ObservedProcess(process.execPath, [cliPath, ...arguments_], {
        cwd: repositoryRoot,
        env: environment,
    });
}

export async function startProductionMobiusCli(
    deployment: StandaloneDeployment,
    pairing: StandalonePairing,
    options: {
        readonly agentEnvironment?: Readonly<Record<string, string>>;
    } = {},
): Promise<ProductionMobiusCli> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-e2e-cli-"));
    const workspace = join(temporaryDirectory, "workspace");
    await mkdir(workspace, { recursive: true });
    const environment = {
        ...process.env,
        ...(options.agentEnvironment ?? (await createFakeCodex(temporaryDirectory))),
        ...(options.agentEnvironment === undefined
            ? { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(temporaryDirectory, "agent-state") }
            : {}),
        MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "mobius-state"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
    };
    const process_ = spawnCli(
        ["pair", "--url", deployment.origin, "--code", pairing.pairingCode, "--workspace", workspace],
        environment,
    );
    try {
        await process_.waitFor("Mobius daemon connected to the relay.", 20_000);
        return new ProductionMobiusCli(pairing.channelId, environment, process_, temporaryDirectory);
    } catch (cause) {
        await process_.stop();
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw cause;
    }
}
