import { expect, test } from "vitest";
import { decodeKnownServiceToDaemonMessage } from "../../src/protocol/transport/daemon-transport.ts";

test("Given additive diagnostics fields, When an older operation is decoded, Then known fields still execute", () => {
    expect(
        decodeKnownServiceToDaemonMessage(
            JSON.stringify({
                kind: "runtime.diagnostics.read",
                requestId: "request-1",
                futureFormat: { version: 3 },
            }),
        ),
    ).toEqual({ kind: "runtime.diagnostics.read", requestId: "request-1" });
});

test("Given a future sender adds fields, When the daemon decodes a known command, Then it retains the existing operation", () => {
    expect(
        decodeKnownServiceToDaemonMessage(
            JSON.stringify({
                kind: "workspace.list",
                bindingId: "workspace",
                directoryId: "default",
                requestId: "request-1",
                futureOptions: { format: 3 },
            }),
        ),
    ).toEqual({ kind: "workspace.list", bindingId: "workspace", directoryId: "default", requestId: "request-1" });
});

test("Given a future envelope or invalid known fields, When the daemon decodes it, Then it skips it without executing", () => {
    for (const value of [{ version: 3 }, { kind: "workspace.list", requestId: 42 }, { kind: "future.command" }]) {
        expect(decodeKnownServiceToDaemonMessage(JSON.stringify(value))).toBeNull();
    }
});
