import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { readOrCreateControlToken } from "../../engine/storage/daemon/control-token.ts";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { platformSupportFor } from "../../engine/util/platform/index.ts";

export const CONTROL_TIMEOUT_MILLISECONDS = 130_000;
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;

const managerPlatform = platformSupportFor(process.platform);

export function controlSocketPath(
    stateDirectory: InstallationDirectory,
    endpoint: "manager" | "worker" = "manager",
): string {
    const installationHash = createHash("sha256")
        .update(endpoint === "manager" ? stateDirectory : `${stateDirectory}:worker`)
        .digest("hex")
        .slice(0, 32);
    return managerPlatform.controlSocketPath(installationHash);
}

export async function readSocketMessage(socket: Socket, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
        let encoded = "";
        const finish = (error?: unknown, value?: unknown): void => {
            signal.removeEventListener("abort", abort);
            socket.removeAllListeners("data");
            socket.removeAllListeners("error");
            socket.removeAllListeners("end");
            if (error === undefined) {
                resolve(value);
            } else {
                reject(error);
            }
        };
        const abort = (): void => {
            socket.destroy();
            finish(signal.reason);
        };
        socket.on("data", (chunk: Buffer) => {
            encoded += chunk.toString("utf8");
            if (encoded.length > MAXIMUM_MESSAGE_BYTES) {
                finish(new Error("The manager message is too large"));
                socket.destroy();
                return;
            }
            const newline = encoded.indexOf("\n");
            if (newline >= 0) {
                try {
                    finish(undefined, JSON.parse(encoded.slice(0, newline)));
                } catch (cause) {
                    finish(cause);
                }
            }
        });
        socket.once("error", finish);
        socket.once("end", () => finish(new Error("The manager connection closed without a response")));
        signal.addEventListener("abort", abort, { once: true });
    });
}

export async function sendLocalRequest(
    stateDirectory: InstallationDirectory,
    endpoint: "manager" | "worker",
    command: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<unknown> {
    const token = await readOrCreateControlToken(stateDirectory);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    deadline.throwIfAborted();
    const socket = createConnection(controlSocketPath(stateDirectory, endpoint));
    try {
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                socket.destroy();
                reject(deadline.reason);
            };
            socket.once("connect", () => {
                deadline.removeEventListener("abort", abort);
                resolve();
            });
            socket.once("error", reject);
            deadline.addEventListener("abort", abort, { once: true });
        });
        socket.write(`${JSON.stringify({ ...command, token })}\n`);
        return await readSocketMessage(socket, deadline);
    } finally {
        socket.destroy();
    }
}
