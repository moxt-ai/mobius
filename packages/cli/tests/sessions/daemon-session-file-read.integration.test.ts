import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeFileBeginEvent,
    decodeFileChunkEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    encodeFileReadCommand,
    encodeSessionPrepareCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

interface FileReadResult {
    readonly bytes: Buffer;
    readonly kind: "failed" | "streamed";
    readonly mediaType: string;
    readonly message: string;
}

/** Reads one file through the daemon's public file.read protocol boundary. */
async function readSessionFile(
    peer: Parameters<Parameters<typeof withRealDaemon>[2]>[0],
    sessionId: string,
    path: string,
): Promise<FileReadResult> {
    peer.send(
        encodeFileReadCommand({
            kind: "file.read",
            maxBytes: 65_536,
            path,
            requestId: `read-${path.replaceAll(/[^a-zA-Z0-9]/gu, "-")}`,
            sessionId,
        }),
    );
    const chunks: Buffer[] = [];
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "file.failed") {
            return {
                bytes: Buffer.alloc(0),
                kind: "failed",
                mediaType: "",
                message: decodeFileFailedEvent(message).message,
            };
        }
        if (kind === "file.begin") {
            expect(decodeFileBeginEvent(message).sessionId).toBe(sessionId);
        } else if (kind === "file.chunk") {
            chunks.push(Buffer.from(decodeFileChunkEvent(message).data, "base64"));
        } else if (kind === "file.end") {
            return { bytes: Buffer.concat(chunks), kind: "streamed", mediaType: "", message: "" };
        }
    }
}

test("Given a session with a working directory, When a client reads a root-relative or bare-relative file reference, Then the daemon resolves it against the session directory before the machine root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-session-file-read-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "assets", "каталог résumé"), { recursive: true });
    await writeFile(join(workspace, "index.html"), "<!doctype html>\n<title>Todo</title>\n");
    await writeFile(join(workspace, "assets", "каталог résumé", "app.js"), "export const todo = true;\n");
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            { PATH: executableDirectory },
            async (peer) => {
                peer.send(
                    encodeSessionPrepareCommand({
                        additionalDirectoryIds: [],
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        kind: "session.prepare",
                        requestId: "prepare-file-read-session",
                        sessionId: peer.sessionId,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }

                // Root-relative agent references resolve against the session
                // working directory, not the machine root.
                const rootRelative = await readSessionFile(peer, peer.sessionId, "/index.html");
                expect(rootRelative.kind).toBe("streamed");
                expect(rootRelative.bytes.toString("utf8")).toContain("<title>Todo</title>");

                // Absolute machine paths keep working.
                const absolute = await readSessionFile(peer, peer.sessionId, join(workspace, "index.html"));
                expect(absolute.kind).toBe("streamed");
                expect(absolute.bytes.toString("utf8")).toContain("<title>Todo</title>");

                // Bare-relative references and non-ASCII or nested targets keep resolving.
                const bareRelative = await readSessionFile(peer, peer.sessionId, "index.html");
                expect(bareRelative.kind).toBe("streamed");
                expect(bareRelative.bytes.toString("utf8")).toContain("<title>Todo</title>");
                const nested = await readSessionFile(peer, peer.sessionId, "/assets/каталог résumé/app.js");
                expect(nested.kind).toBe("streamed");
                expect(nested.bytes.toString("utf8")).toContain("export const todo = true;");

                // Missing references fail without inventing a target.
                const missing = await readSessionFile(peer, peer.sessionId, "/missing-file.html");
                expect(missing.kind).toBe("failed");
            },
            "embedded",
            workspace,
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
