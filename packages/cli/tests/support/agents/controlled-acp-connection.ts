import { spawn } from "node:child_process";
import { type ClientConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "../../../src/acp/acp-error.ts";
import type { AcpEndpointTermination } from "../../../src/acp/agent/in-process-endpoint.ts";
import type { AgentConnection, AgentConnectionOptions } from "../../../src/acp/connection/agent-connection.ts";
import { raceAgentOperation } from "../../../src/acp/connection/agent-operation.ts";
import { createAcpClient } from "../../../src/acp/connection/create-client.ts";
import {
    captureProcessTree,
    executableLaunch,
    platformSpawnOptions,
    stopProcessTree,
} from "../../../src/util/process/executable.ts";
import { createWritableAcpStream, readableAcpStream } from "./acp-stream.ts";

interface ControlledAcpLaunch {
    readonly id: string;
    readonly adapterPath: string;
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}

interface ControlledAcpConnectionOptions extends AgentConnectionOptions {
    readonly maximumOutputBytes?: number;
}

/** Stateful controlled ACP peer transport used only by daemon integration scenarios. */
export class ControlledAcpConnection implements AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AcpEndpointTermination>;
    readonly #child: ReturnType<typeof spawn>;
    readonly #consumeStderr: (chunk: Buffer) => void;
    #closePromise: Promise<void> | null = null;

    constructor(agent: ControlledAcpLaunch, options: ControlledAcpConnectionOptions) {
        const launch = executableLaunch(agent.adapterPath, agent.arguments);
        const child = spawn(launch.command, [...launch.arguments], {
            cwd: options.cwd,
            ...platformSpawnOptions,
            env: { ...process.env, ...agent.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.#child = child;
        const { stdin, stdout, stderr } = child;
        if (stdin === null || stdout === null || stderr === null) {
            child.kill("SIGKILL");
            throw new AcpExecutionError("ACP process streams are unavailable");
        }
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        this.termination = termination.promise;
        child.once("error", (cause) => {
            termination.resolve({
                kind: "failed",
                error: new AcpExecutionError("The ACP process could not run", { cause }),
            });
        });
        child.once("exit", (code, signal) => {
            termination.resolve({
                kind: "failed",
                error: new AcpExecutionError("The ACP process stopped", { cause: { code, signal } }),
            });
        });
        let stderrBytes = 0;
        this.#consumeStderr = (chunk) => {
            if (options.maximumOutputBytes !== undefined) {
                stderrBytes += chunk.byteLength;
                if (stderrBytes > options.maximumOutputBytes) {
                    termination.resolve({
                        kind: "failed",
                        error: new AcpExecutionError("ACP adapter error output limit exceeded"),
                    });
                }
                return;
            }
            process.stderr.write(`[${agent.id}-acp] ${chunk.toString("utf8")}`);
        };
        stderr.on("data", this.#consumeStderr);
        const stream = ndJsonStream(
            createWritableAcpStream(stdin),
            readableAcpStream(stdout, options.maximumOutputBytes),
        );
        let pendingUpdates = 0;
        const client = options.client;
        this.connection = createAcpClient({
            onElicitation: client.onElicitation,
            onElicitationComplete: client.onElicitationComplete,
            onPermission: client.onPermission,
            // ACP notifications acknowledge writes, not consumption. Pause the child
            // while updates drain so the OS pipe backpressures history replay.
            onUpdate: async (notification) => {
                pendingUpdates += 1;
                stdout.pause();
                try {
                    await client.onUpdate(notification);
                } finally {
                    pendingUpdates -= 1;
                    if (pendingUpdates === 0) {
                        stdout.resume();
                    }
                }
            },
        }).connect(stream);
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly agentSettingsModelEffort = () => null;

    readonly closeProcess = (): Promise<void> => {
        this.#closePromise ??= (async () => {
            try {
                const captured = await captureProcessTree(this.#child);
                this.connection.close();
                this.#child.stdin?.end();
                await stopProcessTree(this.#child, captured);
            } finally {
                this.#child.stderr?.removeListener("data", this.#consumeStderr);
                this.connection.close();
            }
        })();
        return this.#closePromise;
    };

    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        raceAgentOperation(operation, this.termination, exitMessage, signal);
}
