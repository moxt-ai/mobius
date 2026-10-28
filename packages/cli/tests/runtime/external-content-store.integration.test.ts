import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { LocalExternalContentStore } from "../../src/engine/session/content/external-content-store.ts";

test("Given two Sessions produce identical media, When each retrieves its granted reference, Then they share one file while an unrelated Session cannot read it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-media-cache-"));
    try {
        await using cache = new LocalExternalContentStore(directory);
        const bytes = Buffer.from("media owned by both Sessions");
        const signal = new AbortController().signal;
        const first = await cache.put({
            bytes,
            kind: "resource",
            mediaType: "text/plain",
            name: "result",
            sessionId: "first",
            signal,
        });
        const request = `mobius-content:resource:${first.key}`;
        expect(first.key).toBe(createHash("sha256").update(bytes).digest("hex"));
        const original = await cache.resolve("first", request, signal);
        expect(original).not.toBeNull();
        expect(await cache.resolve("second", request, signal)).toBeNull();
        const second = await cache.put({
            bytes,
            kind: "resource",
            mediaType: "text/plain",
            name: "result",
            sessionId: "second",
            signal,
        });
        expect(second).toEqual(first);
        expect(await cache.resolve("second", request, signal)).toEqual(original);
        expect(await cache.resolve("unrelated", request, signal)).toBeNull();
        if (original === null) {
            throw new Error("Expected a retrievable media file");
        }
        expect(await readFile(original.path)).toEqual(bytes);
        expect((await stat(original.path)).mode & 0o777).toBe(0o600);
        vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
        expect(await cache.resolve("first", request, signal)).toBeNull();
        await expect(stat(original.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        vi.useRealTimers();
        await rm(directory, { force: true, recursive: true });
    }
});

test("Given a daemon's disposable media cache, When the owner closes it, Then files and grants disappear and a new daemon cannot read old references", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-media-close-"));
    try {
        const cache = new LocalExternalContentStore(directory);
        const signal = new AbortController().signal;
        const reference = await cache.put({
            bytes: Buffer.from("temporary"),
            kind: "resource",
            mediaType: "text/plain",
            name: "result",
            sessionId: "owner",
            signal,
        });
        const request = `mobius-content:resource:${reference.key}`;
        const original = await cache.resolve("owner", request, signal);
        if (original === null) {
            throw new Error("Expected a retrievable media file");
        }
        await cache[Symbol.asyncDispose]();
        await expect(stat(original.path)).rejects.toMatchObject({ code: "ENOENT" });
        await using restarted = new LocalExternalContentStore(directory);
        expect(await restarted.resolve("owner", request, signal)).toBeNull();
    } finally {
        vi.useRealTimers();
        await rm(directory, { force: true, recursive: true });
    }
});
