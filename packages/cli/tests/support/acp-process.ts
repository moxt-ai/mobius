import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPromptText(value: unknown): string {
    if (!Array.isArray(value)) {
        return "";
    }

    let text = "";
    for (const block of value) {
        if (!isRecord(block) || block["type"] !== "text") {
            continue;
        }
        const blockText = block["text"];
        if (typeof blockText === "string") {
            text += blockText;
        }
    }
    return text;
}

export function readAgentName(): string {
    const optionIndex = process.argv.indexOf("--agent-name");
    if (optionIndex < 0) {
        return "";
    }
    return process.argv[optionIndex + 1] ?? "";
}

export function readAgentVersion(): string {
    const optionIndex = process.argv.indexOf("--agent-version");
    if (optionIndex < 0) {
        return "1.0.0";
    }
    return process.argv[optionIndex + 1] ?? "";
}

export function exitsAfterSessionCreation(): boolean {
    return process.argv.includes("--exit-after-session-creation");
}

export function persistsEmptySessions(): boolean {
    return !process.argv.includes("--persist-after-first-prompt");
}

export function countPromptBlock(prompt: readonly acp.ContentBlock[], type: string): number {
    return prompt.filter((block) => block.type === type).length;
}

export function readableWebStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    let streamOpen = true;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!streamOpen) {
                    return;
                }
                if (chunk instanceof Uint8Array) {
                    controller.enqueue(new Uint8Array(chunk));
                    return;
                }
                streamOpen = false;
                controller.error(new Error("ACP stdin produced a non-binary chunk"));
            });
            input.once("end", () => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.close();
            });
            input.once("error", (error) => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.error(error);
            });
        },
        cancel() {
            streamOpen = false;
        },
    });
}

export function writableWebStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                output.write(chunk, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

export function waitForFile(directory: string, name: string, signal: AbortSignal): Promise<void> {
    const path = join(directory, name);
    if (existsSync(path) || signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const watcher = watch(directory, () => {
            if (existsSync(path)) {
                finish();
            }
        });
        const finish = () => {
            watcher.close();
            signal.removeEventListener("abort", finish);
            resolve();
        };
        signal.addEventListener("abort", finish, { once: true });
        if (existsSync(path) || signal.aborted) {
            finish();
        }
    });
}
