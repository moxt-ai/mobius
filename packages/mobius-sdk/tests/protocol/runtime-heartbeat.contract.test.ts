import { expect, it } from "vitest";
import {
    decodeDaemonToRelayMessage,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeServiceToDaemonMessage,
    ProtocolMessageError,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
} from "../../src/protocol/index.ts";

it("Given fixed-text Runtime heartbeats, When either peer decodes them, Then the heartbeat and acknowledgement remain supported", () => {
    expect(decodeDaemonToRelayMessage(RUNTIME_HEARTBEAT_MESSAGE)).toEqual({ kind: "runtime.heartbeat" });
    expect(decodeServiceToDaemonMessage(RUNTIME_HEARTBEAT_ACK_MESSAGE)).toEqual({ kind: "runtime.heartbeat.ack" });
});

it.each(["runtime.heartbeat", "runtime.heartbeat.ack"])(
    "Given a retired identified %s frame, When a peer decodes it, Then it rejects the unsupported protocol instead of ignoring its identifier",
    (kind) => {
        const encoded = JSON.stringify({ kind, heartbeatId: "retired-heartbeat" });
        const decode = kind === "runtime.heartbeat" ? decodeRuntimeHeartbeatEvent : decodeRuntimeHeartbeatAckEvent;
        expect(() => decode(encoded)).toThrow(ProtocolMessageError);
        if (kind === "runtime.heartbeat") {
            expect(decodeDaemonToRelayMessage(encoded)).toBeNull();
        } else {
            expect(() => decodeServiceToDaemonMessage(encoded)).toThrow(ProtocolMessageError);
        }
    },
);
