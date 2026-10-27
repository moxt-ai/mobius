import { createServer, request } from "node:http";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, expect, test, vi } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

afterEach(() => vi.useRealTimers());

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
