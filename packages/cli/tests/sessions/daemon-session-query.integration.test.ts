import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionReadyEvent,
    decodeSessionsQueriedEvent,
    encodeSessionPrepareCommand,
    encodeSessionQueryCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import type { AgentConnectionFactory } from "../../src/engine/acp/connection/agent-connection.ts";
import { InProcessAcpAgentSpecification } from "../../src/engine/agent/specification/agent-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

const NATIVE_AGENT_ID = "claude";

class ControlledAgentSpecification extends InProcessAcpAgentSpecification {
    readonly agentExecutable = "node";
    readonly id = NATIVE_AGENT_ID;
    readonly label = "Controlled Claude";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createConnection: AgentConnectionFactory = this.sessions.createConnection;

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_QUERY_PATH");
    }
}

/** The message that answers `requestId`, which must be of `kind` rather than a failure. */
async function reply(peer: RealDaemonPeer, kind: string, requestId: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const answered: unknown = JSON.parse(message);
        if (typeof answered === "object" && answered !== null && "requestId" in answered) {
            if (answered.requestId === requestId) {
                expect(decodeMessageKind(message)).toBe(kind);
                return message;
            }
        }
    }
}

async function prepare(peer: RealDaemonPeer, sessionId: string, directoryId: string): Promise<void> {
    const requestId = crypto.randomUUID();
    peer.send(
        encodeSessionPrepareCommand({
            additionalDirectoryIds: [],
            agentId: NATIVE_AGENT_ID,
            bindingId: peer.bindingId,
            directoryId,
            kind: "session.prepare",
            requestId,
            sessionId,
        }),
    );
    expect(decodeSessionReadyEvent(await reply(peer, "session.ready", requestId)).requestId).toBe(requestId);
}

test("Given a Session whose directory was deleted, When a client queries it with other Sessions, Then every Session is described with its recorded directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "mobius-session-query-")));
    const deleted = join(root, "deleted-project");
    await mkdir(deleted);
    const deletedDirectoryId = `path-${Buffer.from(deleted, "utf8").toString("base64url")}`;
    const specification = new ControlledAgentSpecification();
    try {
        await withControlledDaemon(
            specification,
            { MOBIUS_TEST_CONTROLLED_QUERY_PATH: process.execPath },
            async (peer) => {
                const kept = crypto.randomUUID();
                const orphaned = crypto.randomUUID();
                await prepare(peer, kept, "default");
                await prepare(peer, orphaned, deletedDirectoryId);
                await rm(deleted, { recursive: true, force: true });

                const requestId = crypto.randomUUID();
                peer.send(
                    encodeSessionQueryCommand({ kind: "session.query", requestId, sessionIds: [kept, orphaned] }),
                );
                const { entries } = decodeSessionsQueriedEvent(await reply(peer, "session.queried", requestId));

                expect(entries.map((entry) => entry.sessionId).sort()).toEqual([kept, orphaned].sort());
                expect(entries.find((entry) => entry.sessionId === orphaned)?.directoryId).toBe(deletedDirectoryId);
            },
        );
    } finally {
        specification.sessions.releaseAll();
        await rm(root, { recursive: true, force: true });
    }
});
