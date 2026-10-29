import { expect, it } from "vitest";
import {
    decodeDaemonToRelayMessage,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
} from "../../src/protocol/index.ts";

it("Given fixed-text Runtime heartbeats, When either peer decodes them, Then the heartbeat and acknowledgement remain supported", () => {
    expect(decodeDaemonToRelayMessage(RUNTIME_HEARTBEAT_MESSAGE)).toEqual({ kind: "runtime.heartbeat" });
    expect(decodeServiceToDaemonMessage(RUNTIME_HEARTBEAT_ACK_MESSAGE)).toEqual({ kind: "runtime.heartbeat.ack" });
});

it.each(["runtime.heartbeat", "runtime.heartbeat.ack"])(
    "Given a %s frame with unknown fields, When a peer decodes it, Then only its supported kind is retained",
    (kind) => {
        const encoded = JSON.stringify({ kind, extra: "ignored" });
        const decode = kind === "runtime.heartbeat" ? decodeRuntimeHeartbeatEvent : decodeRuntimeHeartbeatAckEvent;
        expect(decode(encoded)).toEqual({ kind });
        if (kind === "runtime.heartbeat") {
            expect(decodeDaemonToRelayMessage(encoded)).toEqual({ kind });
        } else {
            expect(decodeServiceToDaemonMessage(encoded)).toEqual({ kind });
        }
    },
);
