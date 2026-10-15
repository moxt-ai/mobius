import { createHash, randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { platformSupportFor } from "./platform/index.ts";

export const CONTROL_TIMEOUT_MILLISECONDS = 130_000;
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;

export async function acquireManagerLock(
    stateDirectory: string,
    name = "manager.lock",
): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await writeFile(path, `${process.pid.toString()}\n`, { flag: "wx", mode: 0o600 });
            return async () => await unlink(path).catch(() => undefined);
        } catch (cause) {
            if (!isNodeError(cause, "EEXIST")) {
                throw cause;
            }
            const encoded = await readFile(path, "utf8").catch(() => "");
            const pid = Number(encoded.trim());
            if (Number.isSafeInteger(pid) && pid > 1) {
                try {
                    process.kill(pid, 0);
                    return null;
                } catch (probeCause) {
                    if (!isNodeError(probeCause, "ESRCH")) {
                        return null;
                    }
                }
            }
            await unlink(path).catch(() => undefined);
        }
    }
    return null;
}

const managerPlatform = platformSupportFor(process.platform);

export function controlSocketPath(stateDirectory: string, endpoint: "manager" | "worker" = "manager"): string {
    const installationHash = createHash("sha256")
        .update(endpoint === "manager" ? stateDirectory : `${stateDirectory}:worker`)
        .digest("hex")
        .slice(0, 32);
    return managerPlatform.controlSocketPath(installationHash);
}

function controlTokenPath(stateDirectory: string): string {
    return join(stateDirectory, "manager.token");
}

export async function readOrCreateControlToken(stateDirectory: string): Promise<string> {
    const path = controlTokenPath(stateDirectory);
    try {
        return (await readFile(path, "utf8")).trim();
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    const token = randomBytes(32).toString("base64url");
    try {
        await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
        return token;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw cause;
        }
        return (await readFile(path, "utf8")).trim();
    }
}

export function isNodeError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
    stateDirectory: string,
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
