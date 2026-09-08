import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { LocalAgentDefinition } from "../src/agent-catalog/local-agent.ts";
import { readCodexHistory } from "../src/native-sessions/codex-history.ts";

const acpUrl = new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url).toString();
const appServerUrl = new URL("../../../e2e/fixtures/fake-acp-agent/src/app-server.ts", import.meta.url).toString();

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-reader-"));
    const native = join(directory, "native");
    await mkdir(native);
    const executable = join(directory, "codex.mjs");
    await writeFile(
        executable,
        `#!${process.execPath}\nawait import(process.argv.includes("app-server") ? ${JSON.stringify(appServerUrl)} : ${JSON.stringify(acpUrl)});\n`,
        { mode: 0o700 },
    );
    const agent = new LocalAgentDefinition("codex", "Codex", executable, ["--exclusive-writer"], {
        MOBIUS_FAKE_ACP_STATE_DIRECTORY: native,
    });
    const external = new AcpSessionManager();
    await external.runPrompt({
        agent,
        cwd: directory,
        additionalDirectories: [],
        sessionId: "external",
        commandId: "seed-history",
        prompt: "Keep this saved conversation available",
        images: [],
        resources: [],
        onText: async () => {},
        onActivity: async () => {},
        signal: new AbortController().signal,
    });
    const filename = (await readdir(native)).find((name) => name.endsWith(".json"));
    if (filename === undefined) {
        throw new Error("The external Agent did not save its conversation");
    }
    const nativeId = decodeURIComponent(filename.slice(0, -5));
    const close = async (): Promise<void> => {
        await external.close();
        await rm(directory, { recursive: true, force: true });
    };
    return { agent, directory, external, native, nativeId, close };
}

describe("Codex saved history boundary", () => {
    it("Given a saved Codex conversation exceeds the full-history size limit, When its recent history is opened, Then only the last ten messages are returned in conversation order", {
        timeout: 45_000,
    }, async () => {
        const f = await fixture();
        try {
            // Grow real persisted Agent state through its prompt port. Full-history
            // hydration exceeds 32 MiB, while the latest conversation is small.
            for (let index = 0; index < 9; index += 1) {
                await f.external.runPrompt({
                    agent: f.agent,
                    cwd: f.directory,
                    additionalDirectories: [],
                    sessionId: "external",
                    commandId: `large-${index.toString()}`,
                    prompt: "Earlier context ".repeat(140_000),
                    images: [],
                    resources: [],
                    onText: async () => {},
                    onActivity: async () => {},
                    signal: new AbortController().signal,
                });
            }
            for (let index = 0; index < 6; index += 1) {
                await f.external.runPrompt({
                    agent: f.agent,
                    cwd: f.directory,
                    additionalDirectories: [],
                    sessionId: "external",
                    commandId: `recent-${index.toString()}`,
                    prompt: `Recent question ${index.toString()}`,
                    images: [],
                    resources: [],
                    onText: async () => {},
                    onActivity: async () => {},
                    signal: new AbortController().signal,
                });
            }
            const snapshot = await readCodexHistory(f.agent, f.directory, f.nativeId, new AbortController().signal);
            expect(snapshot.history).toMatchObject({
                status: "available",
                truncated: true,
                messages: Array.from({ length: 5 }, (_, index) => [
                    { role: "user", text: `Recent question ${(index + 1).toString()}` },
                    {
                        role: "assistant",
                        text: `Echo from ACP: Recent question ${(index + 1).toString()}`,
                    },
                ]).flat(),
            });
            expect((await readdir(f.native)).filter((name) => name.endsWith(".reader"))).toEqual([]);
            await f.external.close();
            const importer = new AcpSessionManager();
            try {
                const imported = await importer.openNativeSession(
                    {
                        agent: f.agent,
                        cwd: f.directory,
                        additionalDirectories: [],
                        sessionId: "recent-import",
                        signal: new AbortController().signal,
                    },
                    { kind: "import", nativeSessionId: f.nativeId },
                );
                expect(imported.history).toEqual(snapshot.history);
            } finally {
                await importer.close();
            }
        } finally {
            await f.close();
        }
    });

    it.each(["cancelled", "timed out"])(
        "Given Codex history storage is unavailable, When a read is %s, Then its reader exits and the original conversation remains usable",
        async (outcome) => {
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
            vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
            const f = await fixture();
            const controller = new AbortController();
            const readerStarted = Promise.withResolvers<number>();
            const watcher = watch(f.native, (_event, filename) => {
                if (filename?.endsWith(".reader")) {
                    readerStarted.resolve(Number(filename.slice(0, -7)));
                }
            });
            try {
                await writeFile(join(f.native, "pause-read"), "");
                const result = readCodexHistory(f.agent, f.directory, f.nativeId, controller.signal).catch(
                    (error: unknown) => error,
                );
                const readerPid = await readerStarted.promise;
                if (outcome === "cancelled") {
                    controller.abort(new DOMException("Cancelled by browser", "AbortError"));
                } else {
                    await vi.advanceTimersByTimeAsync(15_000);
                }
                expect(await result).toMatchObject(
                    outcome === "cancelled" ? { name: "AbortError" } : { code: "native_history_timeout" },
                );
                expect(() => process.kill(readerPid, 0)).toThrow();
                expect((await readdir(f.native)).filter((name) => name.endsWith(".reader"))).toEqual([]);
                await expect(
                    f.external.runPrompt({
                        agent: f.agent,
                        cwd: f.directory,
                        additionalDirectories: [],
                        sessionId: "external",
                        commandId: "continue-after-read",
                        prompt: "Continue in the owning app",
                        images: [],
                        resources: [],
                        onText: async () => {},
                        onActivity: async () => {},
                        signal: new AbortController().signal,
                    }),
                ).resolves.toMatchObject({ stopReason: "end_turn" });
            } finally {
                watcher.close();
                controller.abort();
                await f.close();
                vi.useRealTimers();
            }
        },
    );

    it("Given a saved Codex conversation is corrupt, When its history is read, Then a sanitized failure is returned and the reader is released", async () => {
        const f = await fixture();
        try {
            await writeFile(join(f.native, `${encodeURIComponent(f.nativeId)}.json`), "private broken session data");
            const result = await readCodexHistory(f.agent, f.directory, f.nativeId, new AbortController().signal).catch(
                (error: unknown) => error,
            );
            expect(result).toMatchObject({ code: "native_history_unavailable" });
            expect(String(result)).not.toContain("private broken session data");
            expect((await readdir(f.native)).filter((name) => name.endsWith(".reader"))).toEqual([]);
        } finally {
            await f.close();
        }
    });
});
