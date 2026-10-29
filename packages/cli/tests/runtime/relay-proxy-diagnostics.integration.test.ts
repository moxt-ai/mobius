import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createProxy, type IncomingMessage, type ServerResponse } from "node:http";
import {
    createSecureServer,
    type Http2ServerRequest,
    type Http2ServerResponse,
    type IncomingHttpHeaders,
    type ServerHttp2Stream,
} from "node:http2";
import { createServer } from "node:https";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import {
    encodeRuntimeLivenessReadyEvent,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_LIVENESS_READY_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";

afterEach(() => vi.useRealTimers());

async function fixture(mode: "healthy" | "reject-http1" | "reject-http2" | "reset-pairing" = "healthy") {
    const directory = await mkdtemp(join(tmpdir(), "mobius-relay-proxy-"));
    const key = join(directory, "key.pem");
    const certificate = join(directory, "certificate.pem");
    execFileSync(
        "openssl",
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            certificate,
            "-days",
            "3650",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
    );
    vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00Z"), toFake: ["Date"] });
    const sockets = new Set<Duplex>();
    const claimed: string[] = [];
    const online = new Set<string>();
    const ready = Promise.withResolvers<void>();
    const directReady = Promise.withResolvers<void>();
    const tunnelReady = Promise.withResolvers<Duplex>();
    const tunnelByPort = new Map<number, Duplex>();
    const tls = { key: await readFile(key), cert: await readFile(certificate) };
    const relay =
        mode === "reject-http2"
            ? createSecureServer({ ...tls, allowHTTP1: true, settings: { enableConnectProtocol: true } })
            : createServer(tls);
    const rejectedHttp2: number[] = [];
    relay.on("connect", () => undefined);
    relay.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        stream.on("error", () => undefined);
        if (headers[":protocol"] === "websocket") {
            rejectedHttp2.push(403);
            stream.respond({ ":status": 403 });
            stream.end();
        }
    });
    relay.on(
        "request",
        (request: IncomingMessage | Http2ServerRequest, response: ServerResponse | Http2ServerResponse) => {
            const pairing = request.url?.match(/\/runtime-pairings\/(direct-pairing|proxy-pairing)\/redeem$/u)?.[1];
            if (pairing !== undefined) {
                claimed.push(pairing);
                const role = pairing === "direct-pairing" ? "direct" : "proxy";
                if (role === "proxy" && mode === "reset-pairing") {
                    const tunnel = tunnelByPort.get(request.socket.remotePort ?? 0);
                    if (!(tunnel instanceof Socket)) {
                        throw new Error("The proxy pairing did not use a CONNECT socket");
                    }
                    tunnel.resetAndDestroy();
                    return;
                }
                response.statusCode = 200;
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        appId: "app_probe",
                        channelId: `chn_${role}`,
                        runtimeId: `rnt_${role}`,
                        runtimeCredential: role[0]?.repeat(43),
                    }),
                );
                return;
            }
            if (request.method === "PUT" && request.url?.endsWith("/catalog")) {
                request.resume();
                response.statusCode = 204;
                response.end();
                return;
            }
            response.statusCode = 404;
            response.end();
        },
    );
    relay.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    const websocket = new WebSocketServer({ noServer: true });
    relay.on("upgrade", (request, socket, head) => {
        if (mode === "reject-http1" && request.headers.authorization === `Bearer ${"p".repeat(43)}`) {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        websocket.handleUpgrade(request, socket, head, (connection) =>
            websocket.emit("connection", connection, request),
        );
    });
    websocket.on("connection", (socket, request) => {
        const tunnel = tunnelByPort.get(request.socket.remotePort ?? 0);
        if (tunnel !== undefined) {
            tunnelReady.resolve(tunnel);
        }
        const role = request.headers.authorization === `Bearer ${"d".repeat(43)}` ? "direct" : "proxy";
        socket.on("error", () => undefined);
        socket.on("message", (data) => {
            if (data.toString() === RUNTIME_HEARTBEAT_MESSAGE) {
                socket.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
                online.add(role);
                if (role === "direct") {
                    directReady.resolve();
                }
                if (online.size === 2) {
                    ready.resolve();
                }
            }
        });
        socket.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
    });
    const tunnels: string[] = [];
    const proxy = createProxy();
    proxy.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, downstream, head) => {
        const target = new URL(`http://${request.url}`);
        tunnels.push(target.host);
        const upstream = connect(Number(target.port), target.hostname, () => {
            downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) {
                upstream.write(head);
            }
            downstream.pipe(upstream).pipe(downstream);
            if (upstream.localPort !== undefined) {
                tunnelByPort.set(upstream.localPort, downstream);
            }
        });
        sockets.add(upstream);
        upstream.on("error", () => downstream.destroy());
        downstream.on("error", () => upstream.destroy());
        upstream.on("close", () => {
            sockets.delete(upstream);
            downstream.destroy();
        });
        downstream.on("close", () => upstream.destroy());
    });
    await Promise.all([new Promise<void>((done) => relay.listen(0, "127.0.0.1", done)), listen(proxy)]);
    const relayAddress = relay.address();
    if (relayAddress === null || typeof relayAddress === "string") {
        throw new Error("The Relay did not bind a TCP port");
    }
    const origin = `https://127.0.0.1:${relayAddress.port}`;
    const config = join(directory, "pairings.json");
    await writeFile(
        config,
        JSON.stringify({
            relayOrigin: origin,
            direct: { pairingId: "direct-pairing", pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" },
            proxy: { pairingId: "proxy-pairing", pairingCode: "VWXY-ZABC-DEFG-HJKL-MNPQ" },
        }),
        { mode: 0o600 },
    );
    const output = join(directory, "report");
    let child: ChildProcessWithoutNullStreams | undefined;
    let stdout = "";
    let stderr = "";
    const transportFailure = Promise.withResolvers<void>();
    const run = () => {
        child = spawn(
            process.execPath,
            [
                process.env["MOBIUS_TEST_CLI_ENTRYPOINT"] ?? resolve("src/cli/entrypoint.ts"),
                "diagnose",
                "relay",
                "--config",
                config,
                "--output",
                output,
                "--duration",
                "600",
            ],
            {
                env: {
                    PATH: "",
                    HOME: directory,
                    NODE_EXTRA_CA_CERTS: certificate,
                    HTTPS_PROXY: `http://fixture-user:fixture-password@127.0.0.1:${port(proxy)}`,
                    HTTP_PROXY: `http://fixture-user:fixture-password@127.0.0.1:${port(proxy)}`,
                    NO_PROXY: "*",
                    MOBIUS_STATE_DIRECTORY: join(directory, "existing-installation"),
                },
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
            if (stderr.includes("relay_transport_failed")) {
                transportFailure.resolve();
            }
        });
        const finished = new Promise<number | null>((resolve_, reject) => {
            child?.once("error", reject);
            child?.once("close", (code) => resolve_(code));
        });
        const stopped = finished.then(() => {
            throw new Error(`Probe exited before the expected network event: ${stdout}\n${stderr}`);
        });
        void stopped.catch(() => undefined);
        return {
            finished,
            online: () => Promise.race([ready.promise, stopped]),
            directOnline: () => Promise.race([directReady.promise, stopped]),
            failed: () => Promise.race([transportFailure.promise, stopped]),
            stop: () => child?.kill("SIGINT"),
        };
    };
    return {
        directory,
        output,
        config,
        origin,
        claimed,
        tunnels,
        rejectedHttp2,
        run,
        tunnelReady,
        report: async () => {
            const artifactDirectory =
                process.env["MOBIUS_TEST_ARTIFACT_DIRECTORY"] ?? join(tmpdir(), "mobius-relay-proxy-evidence");
            await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
            const path = join(output, "report.json");
            await copyFile(path, join(artifactDirectory, `${directory.split(/[/\\]/u).pop() ?? "probe"}.json`));
            return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
        },
        text: () => stdout + stderr,
        [Symbol.asyncDispose]: async () => {
            if (child !== undefined && child.exitCode === null) {
                child.kill("SIGKILL");
            }
            for (const socket of sockets) {
                socket.destroy();
            }
            websocket.close();
            await Promise.all([
                new Promise<void>((done) => relay.close(() => done())),
                new Promise<void>((done) => proxy.close(() => done())),
            ]);
            await rm(directory, { recursive: true, force: true });
        },
    };
}

// @no-uc: Technical regression; isolated transport diagnostics must not mutate an existing Runtime or conceal the effective route.
test("Given distinct fresh pairings, When direct and proxy probes run together over WSS, Then the report retains both ready channels and their route evidence", async () => {
    await using peer = await fixture();
    const probe = peer.run();
    await probe.online();
    probe.stop();
    expect(await probe.finished).toBe(0);
    const report = await peer.report();
    expect(peer.claimed.sort()).toEqual(["direct-pairing", "proxy-pairing"]);
    expect(peer.tunnels).toContain(new URL(peer.origin).host);
    expect(report).toMatchObject({
        targetOrigin: new URL(peer.origin).origin,
        legs: [
            { role: "direct", channelId: "chn_direct", onlineCount: 1 },
            { role: "proxy", channelId: "chn_proxy", onlineCount: 1 },
        ],
    });
    const encoded = JSON.stringify(report);
    for (const secret of [
        "fixture-password",
        "fixture-user",
        "d".repeat(43),
        "p".repeat(43),
        "ABCD-EFGH-JKLM-NPQR-STUV",
    ]) {
        expect(encoded + peer.text()).not.toContain(secret);
    }
});

// @no-uc: Technical regression; a reset must retain its raw socket code and must not be attributed to a healthy concurrent channel.
test("Given healthy concurrent channels, When only the proxy tunnel resets, Then its raw error is recorded while the direct channel remains healthy", async () => {
    await using peer = await fixture();
    const probe = peer.run();
    await probe.online();
    const tunnel = await peer.tunnelReady.promise;
    if (!(tunnel instanceof Socket)) {
        throw new Error("The CONNECT peer did not provide a TCP socket");
    }
    tunnel.resetAndDestroy();
    await probe.failed();
    probe.stop();
    expect(await probe.finished).toBe(0);
    const report = await peer.report();
    expect(report).toMatchObject({
        legs: [
            { role: "direct", transportFailures: [] },
            { role: "proxy", transportFailures: [{ event: "relay_transport_failed", failureCode: "ECONNRESET" }] },
        ],
    });
});

// @no-uc: Technical regression; duplicate pairings must be rejected before either network leg can attach to the same Runtime.
test("Given a reused pairing, When a comparison is requested, Then it fails before redeeming or attaching either leg", async () => {
    await using peer = await fixture();
    await writeFile(
        peer.config,
        JSON.stringify({
            relayOrigin: peer.origin,
            direct: { pairingId: "direct-pairing", pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" },
            proxy: { pairingId: "direct-pairing", pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" },
        }),
        { mode: 0o600 },
    );
    const probe = peer.run();
    expect(await probe.finished).toBe(1);
    expect(peer.claimed).toEqual([]);
    expect(peer.text()).toContain("distinct");
    expect(peer.text()).not.toContain("ABCD-EFGH-JKLM-NPQR-STUV");
});

// @no-uc: Technical regression; handshake authorization failures must remain distinguishable from a broken TCP tunnel.
test("Given a Relay rejecting the proxy channel, When its handshake fails, Then the report preserves HTTP 403 while retaining the healthy direct channel", async () => {
    await using peer = await fixture("reject-http1");
    const probe = peer.run();
    await Promise.all([probe.directOnline(), probe.failed()]);
    probe.stop();
    expect(await probe.finished).toBe(1);
    expect(await peer.report()).toMatchObject({
        failure: "probe_not_ready",
        legs: [
            { role: "direct", onlineCount: 1, transportFailures: [] },
            {
                role: "proxy",
                onlineCount: 0,
                transportFailures: [
                    { source: "handshake", failureCode: "relay_handshake_rejected", failureStatusCode: "403" },
                ],
            },
        ],
    });
});

// @no-uc: Technical regression; network failures before pairing must retain original cause codes and best-effort route evidence.
test("Given a reset during proxy pairing, When comparison preparation fails, Then its report retains the native failure and routes without attaching either channel", async () => {
    await using peer = await fixture("reset-pairing");
    const probe = peer.run();
    expect(await probe.finished).toBe(1);
    expect(await peer.report()).toMatchObject({
        failure: "relay_unavailable",
        legs: [
            { role: "direct", onlineCount: 0 },
            {
                role: "proxy",
                onlineCount: 0,
                preparationFailures: [{ failureCode: "relay_unavailable", cause2Code: "ECONNRESET" }],
                routesBefore: [
                    { hostname: "127.0.0.1", addresses: ["127.0.0.1"] },
                    { hostname: "127.0.0.1", addresses: ["127.0.0.1"] },
                ],
            },
        ],
    });
    expect(peer.text()).not.toContain("fixture-password");
});

// @no-uc: Technical regression; HTTP/2 extended CONNECT rejections must retain status before the transport reduces them to bad upgrade.
test("Given an HTTP/2 Relay rejecting extended CONNECT, When the handshake fails, Then the comparison report retains HTTP 403", async () => {
    await using peer = await fixture("reject-http2");
    const probe = peer.run();
    await probe.failed();
    probe.stop();
    expect(await probe.finished).toBe(1);
    expect(peer.rejectedHttp2).toContain(403);
    const report = await peer.report();
    expect(report["legs"]).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                transportFailures: expect.arrayContaining([
                    expect.objectContaining({
                        source: "handshake",
                        failureCode: "relay_handshake_rejected",
                        failureStatusCode: "403",
                    }),
                ]),
            }),
        ]),
    );
});
