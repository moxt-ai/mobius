import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionLiveStateV3Database } from "../../src/local-databases.ts";
import { SessionLiveStateV3 } from "../../src/native-sessions/session-live-state-v3.ts";

describe("V3 Session live state", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            directories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
        );
    });

    it("Given committed native deltas, When the daemon state is reopened, Then sequence allocation continues without retaining event payloads", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-session-v3-state-"));
        directories.push(directory);
        const path = join(directory, "live-state.sqlite");
        const firstDatabase = openSessionLiveStateV3Database(path);
        const first = new SessionLiveStateV3(firstDatabase);
        expect(
            first.commit("session-1", {
                sessionUpdate: "agent_message_chunk",
                messageId: "native-message-1",
                content: { type: "text", text: "Hello " },
            }),
        ).toMatchObject({ sessionId: "session-1", seq: 1 });
        expect(
            first.commit("session-1", {
                sessionUpdate: "agent_message_chunk",
                messageId: "native-message-1",
                content: { type: "text", text: "world" },
            }),
        ).toMatchObject({ sessionId: "session-1", seq: 2 });
        firstDatabase.close();

        const reopenedDatabase = openSessionLiveStateV3Database(path);
        const reopened = new SessionLiveStateV3(reopenedDatabase);
        try {
            expect(
                reopened.commit("session-1", {
                    sessionUpdate: "session_lifecycle_changed",
                    state: { kind: "idle" },
                }),
            ).toEqual({
                sessionId: "session-1",
                seq: 3,
                item: { sessionUpdate: "session_lifecycle_changed", state: { kind: "idle" } },
            });
        } finally {
            reopenedDatabase.close();
        }
    });
});
