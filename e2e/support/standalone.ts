import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type AgentDaemonSocket,
    FakeAgentDaemon,
    type RunningFakeAgentDaemon,
    serveFakeAgentDaemon,
} from "../../tests/infra/agent-daemon.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));
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

    async waitFor(text: string, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        if (this.#output.includes(text)) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const abort = (): void =>
                finish(new Error(`Process did not report ${text}\n${this.#output}`, { cause: signal.reason }));
            const output = (): void => {
                if (this.#output.includes(text)) {
                    finish();
                }
            };
            const exit = (): void => finish(new Error(`Process exited before reporting ${text}\n${this.#output}`));
            const finish = (error?: Error): void => {
                signal.removeEventListener("abort", abort);
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
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
    }

    async stop(): Promise<void> {
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
            return;
        }
        const waitForExit = async (timeoutMilliseconds: number): Promise<boolean> =>
            await new Promise((resolve) => {
                let timeout: ReturnType<typeof setTimeout>;
                const exited = (): void => {
                    clearTimeout(timeout);
                    resolve(true);
                };
                timeout = setTimeout(() => {
                    this.child.removeListener("exit", exited);
                    resolve(this.child.exitCode !== null || this.child.signalCode !== null);
                }, timeoutMilliseconds);
                this.child.once("exit", exited);
            });
        try {
            stopProcessTree(this.child);
        } catch {
            // The process may have exited between the state check and the signal.
        }
        if (await waitForExit(5_000)) {
            return;
        }
        try {
            forceStopProcessTree(this.child);
        } catch {
            // The process may have exited between the timeout and the signal.
        }
        await waitForExit(5_000);
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
        await process_.waitFor("Ready on http://", AbortSignal.timeout(30_000));
        return new StandaloneDeployment(`http://127.0.0.1:${port.toString()}`, process_, temporaryDirectory);
    } catch (cause) {
        await process_.stop();
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw cause;
    }
}

function claimedDaemonToken(value: unknown): string {
    if (!isRecord(value) || typeof value["daemonToken"] !== "string") {
        throw new Error("The Standalone Runtime claim response is invalid");
    }
    return value["daemonToken"];
}

export async function startFakeAgentDaemon(
    deployment: StandaloneDeployment,
    pairing: StandalonePairing,
    signal: AbortSignal,
): Promise<RunningFakeAgentDaemon> {
    const claim = await fetch(new URL("/mobius/api/pairings/claim", deployment.origin), {
        body: JSON.stringify({
            agents: [
                {
                    agentPath: "/fake/codex",
                    agentVersion: "fake-agent-daemon",
                    capabilities: {
                        additionalDirectories: true,
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: true,
                        embeddedContextPrompt: true,
                        imagePrompt: true,
                        listSessions: true,
                        loadSession: true,
                        promptQueueing: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: false,
                    },
                    id: "codex",
                    label: "Codex",
                },
            ],
            installableAgents: [],
            machineName: "Fake Runtime",
            pairingCode: pairing.pairingCode,
            workspaceName: "Fake workspace",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
    });
    if (claim.status !== 200) {
        throw new Error(`Could not claim the Standalone Runtime: ${claim.status.toString()}`);
    }
    const daemonUrl = new URL(`/mobius/api/channels/${pairing.channelId}/daemon`, deployment.origin);
    daemonUrl.protocol = "ws:";
    daemonUrl.searchParams.set("token", claimedDaemonToken(await claim.json()));
    const daemon = await FakeAgentDaemon.connect(
        daemonUrl,
        (url) => new WebSocket(url) as unknown as AgentDaemonSocket,
        signal,
    );
    const behavior = serveFakeAgentDaemon(daemon, { agentName: "Codex" });
    return {
        failure: behavior.failure,
        [Symbol.asyncDispose]: async () => {
            await behavior[Symbol.asyncDispose]();
            daemon.close();
        },
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

    async restartFromSavedChannel(signal: AbortSignal): Promise<void> {
        await this.#process.stop();
        this.#process = spawnCli(["start", "--channel", this.channelId], this.#environment);
        await this.#process.waitFor("Mobius daemon is ready for Agent requests.", signal);
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
        readonly agentEnvironment: Readonly<Record<string, string>>;
        readonly signal: AbortSignal;
    },
): Promise<ProductionMobiusCli> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-e2e-cli-"));
    const workspace = join(temporaryDirectory, "workspace");
    await mkdir(workspace, { recursive: true });
    const environment = {
        ...process.env,
        ...options.agentEnvironment,
        MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "mobius-state"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
    };
    const process_ = spawnCli(
        ["pair", "--url", deployment.origin, "--code", pairing.pairingCode, "--workspace", workspace],
        environment,
    );
    try {
        await process_.waitFor("Mobius daemon is ready for Agent requests.", options.signal);
        return new ProductionMobiusCli(pairing.channelId, environment, process_, temporaryDirectory);
    } catch (cause) {
        await process_.stop();
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw cause;
    }
}
