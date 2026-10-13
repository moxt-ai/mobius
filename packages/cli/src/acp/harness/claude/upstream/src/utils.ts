// A pushable async iterable: allows you to push items and consume them with for-await.

import type { Readable, Writable } from "node:stream";
import { ReadableStream, WritableStream } from "node:stream/web";
import type { Logger } from "./acp-agent.js";

// Useful for bridging push-based and async-iterator-based code.
export class Pushable<T> implements AsyncIterable<T> {
    private queue: T[] = [];
    private resolvers: ((value: IteratorResult<T>) => void)[] = [];
    private done = false;

    push(item: T) {
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            if (resolve === undefined) {
                return;
            }
            resolve({ value: item, done: false });
        } else {
            this.queue.push(item);
        }
    }

    end() {
        this.done = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve?.({ done: true, value: undefined });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: (): Promise<IteratorResult<T>> => {
                if (this.queue.length > 0) {
                    const value = this.queue.shift();
                    if (value === undefined) {
                        return Promise.resolve({ done: true, value: undefined });
                    }
                    return Promise.resolve({ value, done: false });
                }
                if (this.done) {
                    return Promise.resolve({ done: true, value: undefined });
                }
                return new Promise<IteratorResult<T>>((resolve) => {
                    this.resolvers.push(resolve);
                });
            },
        };
    }
}

// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                nodeStream.write(Buffer.from(chunk), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        },
    });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            nodeStream.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => controller.error(err));
        },
    });
}

export function unreachable(value: never, logger: Logger = console) {
    let valueAsString: unknown;
    try {
        valueAsString = JSON.stringify(value);
    } catch {
        valueAsString = value;
    }
    logger.error(`Unexpected case: ${valueAsString}`);
}

export function sleep(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, time));
}
