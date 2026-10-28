import { createServer, request } from "node:http";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, expect, test, vi } from "vitest";
import { startTestPlatform } from "../support/platform.ts";
import { createFakeAgentHarnessRuntime } from "../support/platform-agent-harness.ts";
import { createForkLossProxy } from "./fixtures/fork-loss-proxy.ts";

afterEach(() => vi.useRealTimers());

test.each(["request", "result"] as const)(
    "Given the Runtime Fork %s is lost, When the operation is retried after reconnect, Then only a committed target is recovered",
    async (loss) => {
        vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date"] });
        await using platform = await startTestPlatform();
        const signal = new AbortController().signal;
        const project = await platform.developer.createProject(
            platform.appId,
            {
                clientReference: crypto.randomUUID(),
                displayName: "Runtime Fork loss",
                idempotencyKey: crypto.randomUUID(),
                locationHint: "wnam",
            },
            signal,
        );
        await using proxy = await createForkLossProxy(platform.baseUrl, loss);
        const disconnected = Promise.withResolvers<void>();
        const connected = Promise.withResolvers<void>();
        const reconnected = Promise.withResolvers<void>();
        let wasDisconnected = false;
        await using runtime = await createFakeAgentHarnessRuntime({
            credential: platform.appCredential,
            origin: platform.baseUrl,
            relayOrigin: proxy.origin,
            projectId: project.projectId,
            server: platform.app,
            signal,
            nativeSessionIds: new Set(["native-fork-source"]),
            runtimeOptions: {
                onConnectionStatus: (status) => {
                    if (status === "reconnecting") {
                        wasDisconnected = true;
                        disconnected.resolve();
                    } else {
                        connected.resolve();
                        if (wasDisconnected) {
                            reconnected.resolve();
                        }
                    }
                },
            },
        });
        await connected.promise;
        await runtime.client.runtimes.nativeSessions(
            runtime.runtimeId,
            {
                action: "list",
                agentId: "claude",
                directoryId: "default",
                additionalDirectoryIds: [],
                cursor: null,
                discoveryId: null,
            },
            signal,
        );
        vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
        const operationId = crypto.randomUUID();
        const input = {
            agentId: "claude",
            directoryId: "default",
            additionalDirectoryIds: [],
            nativeSessionId: "native-fork-source",
        };
        const fork = () => runtime.client.runtimes.forkNativeSession(runtime.runtimeId, operationId, input, signal);
        await expect(fork()).rejects.toMatchObject({ code: "native_fork_outcome_unknown" });
        const targetSessionId = await proxy.lost;
        await disconnected.promise;
        await vi.advanceTimersByTimeAsync(500);
        await reconnected.promise;
        if (loss === "request") {
            await expect(fork()).rejects.toMatchObject({ code: "native_fork_outcome_unknown" });
            await expect(fork()).rejects.toMatchObject({ code: "native_fork_outcome_unknown" });
            expect(await runtime.client.runtimes.listSessions(runtime.runtimeId, 100, signal)).toEqual([]);
        } else {
            const [first, concurrent] = await Promise.all([fork(), fork()]);
            expect(concurrent).toEqual(first);
            expect(first.result.targetSessionId).toBe(targetSessionId);
            expect(first.result.ready).toMatchObject({ sessionId: targetSessionId, agentId: "claude", restored: true });
            expect(first.entry.nativeSessionId).toBe(input.nativeSessionId);
            expect(await fork()).toEqual(first);
            const sessions = await runtime.client.runtimes.listSessions(runtime.runtimeId, 100, signal);
            expect(sessions).toHaveLength(1);
            expect(sessions[0]?.sessionId).toBe(targetSessionId);
        }
    },
);

test("Given a Fork succeeds but its response is lost, When the same operation is retried, Then its original Session is returned", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z"), toFake: ["Date"] });
    await using platform = await startTestPlatform();
    const signal = new AbortController().signal;
    const project = await platform.developer.createProject(
        platform.appId,
        {
            clientReference: crypto.randomUUID(),
            displayName: "Fork recovery",
            idempotencyKey: crypto.randomUUID(),
            locationHint: "wnam",
        },
        signal,
    );
    const runtime = await platform.connectAgent(project.projectId, undefined, new Set(["recovery-native-source"]));
    const listingInput = {
        action: "list" as const,
        additionalDirectoryIds: [],
        agentId: "claude",
        cursor: null,
        directoryId: "default",
        discoveryId: null,
    };
    const directory = await runtime.client.runtimes.nativeSessions(runtime.runtimeId, listingInput, signal);
    if (directory.action !== "list" || directory.entries[0] === undefined) {
        throw new Error("No native source");
    }
    const body = JSON.stringify({
        additionalDirectoryIds: [],
        agentId: "claude",
        directoryId: "default",
        nativeSessionId: directory.entries[0].nativeSessionId,
    });
    let loseNextResponse = true;
    let lostStatus: number | undefined;
    const proxy = createServer((incoming, outgoing) => {
        const forwarded = request(
            new URL(incoming.url ?? "/", platform.baseUrl),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(platform.baseUrl).host },
            },
            (response) => {
                if (loseNextResponse) {
                    loseNextResponse = false;
                    lostStatus = response.statusCode;
                    response.resume();
                    response.on("end", () => outgoing.destroy());
                } else {
                    outgoing.writeHead(response.statusCode ?? 502, response.headers);
                    response.pipe(outgoing);
                }
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.pipe(forwarded);
    });
    await listen(proxy);
    try {
        const url = `http://127.0.0.1:${port(proxy)}/mobius/api/v1/projects/${project.projectId}/runtimes/${runtime.runtimeId}/native-session-forks/${crypto.randomUUID()}`;
        const send = () =>
            fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${platform.appCredential}`, "content-type": "application/json" },
                body,
                signal,
            });
        const initial = await Promise.allSettled([send(), send()]);
        expect(initial.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
        const delivered = initial.find((attempt) => attempt.status === "fulfilled");
        if (delivered?.status !== "fulfilled") {
            throw new Error("The concurrent Fork response did not arrive");
        }
        expect(delivered.value.status).toBe(200);
        expect(lostStatus).toBe(200);
        expect(await runtime.client.runtimes.list(signal)).toContainEqual(
            expect.objectContaining({ runtimeId: runtime.runtimeId, nativeForkRecovery: true }),
        );
        const retried = await send();
        expect(retried.status).toBe(200);
        const result: unknown = await retried.json();
        const concurrent = await Promise.all([send(), send()]);
        for (const replay of concurrent) {
            expect(replay.status).toBe(200);
            expect(await replay.json()).toEqual(result);
        }
        const conflict = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${platform.appCredential}`, "content-type": "application/json" },
            body: JSON.stringify({
                additionalDirectoryIds: [],
                agentId: "claude",
                directoryId: "default",
                nativeSessionId: "another-source",
            }),
            signal,
        });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
        const after = await runtime.client.runtimes.listSessions(runtime.runtimeId, 100, signal);
        expect(after).toHaveLength(1); // One tracked fork for the user's one intent; the native source was never imported.
        // Retained pre-receipt HTTP contract: an already-open old client can still fork through the new Relay.
        const legacy = await fetch(
            `${platform.baseUrl}/mobius/api/v1/projects/${project.projectId}/runtimes/${runtime.runtimeId}/native-sessions`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${platform.appCredential}`, "content-type": "application/json" },
                body: JSON.stringify({
                    action: "fork",
                    additionalDirectoryIds: [],
                    agentId: "claude",
                    directoryId: "default",
                    discoveryId: directory.sessionId,
                    entryId: directory.entries[0].entryId,
                }),
                signal,
            },
        );
        expect(legacy.status).toBe(200);
        expect(await legacy.json()).toMatchObject({ action: "fork", ready: { kind: "session.ready" } });
        expect(await runtime.client.runtimes.listSessions(runtime.runtimeId, 100, signal)).toHaveLength(2);
    } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
});
