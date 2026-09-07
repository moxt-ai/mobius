import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      resolve();
    });
  });
}

function readPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return address.port;
}

function trackConnections(server: Server, sockets: Set<Socket>): void {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function closeServer(
  server: Server,
  sockets: Set<Socket>,
): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

describe("CLI environment proxy", () => {
  it("Given proxy environment variables, When pairing and opening the relay, Then both connections use the proxy", async () => {
    const pairingSockets = new Set<Socket>();
    const relaySockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const tunnelTargets: string[] = [];
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-proxy-test-"));

    const pairingServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          channelId: "proxy-channel",
          daemonToken: "a".repeat(32),
          runtimeId: "proxy-runtime",
        }),
      );
    });
    trackConnections(pairingServer, pairingSockets);

    const relayServer = createServer((_request, response) => {
      response.writeHead(426);
      response.end();
    });
    relayServer.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    trackConnections(relayServer, relaySockets);

    const proxyServer = createServer((_request, response) => {
      response.writeHead(405);
      response.end();
    });
    proxyServer.on("connect", (request, downstream, head) => {
      const encodedTarget = request.url;
      if (encodedTarget === undefined) {
        downstream.destroy();
        return;
      }
      const destination = new URL(`http://${encodedTarget}`);
      const destinationPort = Number(destination.port);
      tunnelTargets.push(encodedTarget);
      const upstream = connect(destinationPort, destination.hostname, () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) {
          upstream.write(head);
        }
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
      upstream.once("error", () => downstream.destroy());
    });
    trackConnections(proxyServer, proxySockets);

    await Promise.all([
      listen(pairingServer),
      listen(relayServer),
      listen(proxyServer),
    ]);

    const previousHttpProxy = process.env["HTTP_PROXY"];
    const previousHttpsProxy = process.env["HTTPS_PROXY"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerHttpProxy = process.env["http_proxy"];
    const previousLowerHttpsProxy = process.env["https_proxy"];
    const previousLowerNoProxy = process.env["no_proxy"];
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousPath = process.env["PATH"];
    const proxyUrl = `http://127.0.0.1:${readPort(proxyServer)}`;

    process.env["HTTP_PROXY"] = proxyUrl;
    process.env["HTTPS_PROXY"] = proxyUrl;
    process.env["NO_PROXY"] = "";
    delete process.env["http_proxy"];
    delete process.env["https_proxy"];
    delete process.env["no_proxy"];
    process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
    process.env["PATH"] = "";

    try {
      const { pairLocalMachine } = await import(
        "../src/pairing/pair-local-machine.ts"
      );
      const { connectRelay } = await import(
        "../src/relay-connection/connect.ts"
      );
      const { environmentProxyDispatcher } = await import(
        "../src/network/environment-proxy.ts"
      );

      const pairingPort = readPort(pairingServer);
      await pairLocalMachine([
        "--url",
        `http://127.0.0.1:${pairingPort}`,
        "--code",
        "ABCD-EFGH-JKLM-NPQR-STUV",
        "--workspace",
        process.cwd(),
      ]);

      const relayPort = readPort(relayServer);
      const socket = await connectRelay(
        new URL(`ws://127.0.0.1:${relayPort}/daemon`),
        AbortSignal.timeout(2_000),
      );
      socket.close();

      expect(tunnelTargets).toContain(`127.0.0.1:${pairingPort}`);
      expect(tunnelTargets).toContain(`127.0.0.1:${relayPort}`);
      await environmentProxyDispatcher.close();
    } finally {
      if (previousHttpProxy === undefined) {
        delete process.env["HTTP_PROXY"];
      } else {
        process.env["HTTP_PROXY"] = previousHttpProxy;
      }
      if (previousHttpsProxy === undefined) {
        delete process.env["HTTPS_PROXY"];
      } else {
        process.env["HTTPS_PROXY"] = previousHttpsProxy;
      }
      if (previousNoProxy === undefined) {
        delete process.env["NO_PROXY"];
      } else {
        process.env["NO_PROXY"] = previousNoProxy;
      }
      if (previousLowerHttpProxy === undefined) {
        delete process.env["http_proxy"];
      } else {
        process.env["http_proxy"] = previousLowerHttpProxy;
      }
      if (previousLowerHttpsProxy === undefined) {
        delete process.env["https_proxy"];
      } else {
        process.env["https_proxy"] = previousLowerHttpsProxy;
      }
      if (previousLowerNoProxy === undefined) {
        delete process.env["no_proxy"];
      } else {
        process.env["no_proxy"] = previousLowerNoProxy;
      }
      if (previousStateDirectory === undefined) {
        delete process.env["MOBIUS_STATE_DIRECTORY"];
      } else {
        process.env["MOBIUS_STATE_DIRECTORY"] = previousStateDirectory;
      }
      if (previousPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previousPath;
      }
      await Promise.all([
        closeServer(pairingServer, pairingSockets),
        closeServer(relayServer, relaySockets),
        closeServer(proxyServer, proxySockets),
      ]);
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });
});
