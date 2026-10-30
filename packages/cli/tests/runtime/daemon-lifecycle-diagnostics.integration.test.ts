import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeMessageKind, decodeRuntimeDiagnosticsResult } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Technical regression; process lifecycle logs must reach Runtime bug reports.
test("Given a daemon, When a bug report is read through the Runtime, Then it carries the daemon startup and readiness records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-lifecycle-diagnostics-"));
    const executableDirectory = await writeControlledAcpExecutable(directory);
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent-state"),
                PATH: executableDirectory,
            },
            async (peer) => {
                peer.send(JSON.stringify({ kind: "runtime.diagnostics.read", requestId: "lifecycle-report" }));
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "runtime.diagnostics.result") {
                        continue;
                    }
                    const exported = decodeRuntimeDiagnosticsResult(message);
                    expect(exported.requestId).toBe("lifecycle-report");
                    // Process logs live beside shared control state; diagnostics
                    // must include them alongside this Runtime's own daemon.log.
                    const kinds = exported.entries.map((entry) => entry["kind"] ?? "");
                    expect(kinds).toContain("daemon_started");
                    expect(kinds).toContain("daemon_ready");
                    const ready = exported.entries.find((entry) => entry["kind"] === "daemon_ready");
                    expect(ready?.["version"]).toMatch(/^\d+\.\d+\.\d+$/u);
                    expect(JSON.stringify(exported)).not.toContain(peer.workspace);
                    break;
                }
            },
            "managed",
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}, 180_000);
