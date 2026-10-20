import {
    decodeMobiusChannelDescriptor,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairingStatus,
    MobiusRuntimePairingLifecycle,
} from "@moxt-ai/mobius-sdk";
import { describe, expect, it } from "vitest";

const runtime = {
    agents: [
        {
            agentPath: "/usr/local/bin/codex",
            agentVersion: "codex-cli 1.0.0",
            capabilities: {},
            id: "codex",
            label: "Codex",
        },
    ],
    channelId: "channel-1",
    machineName: "MacBook",
    online: true,
    projectId: "project-1",
    runtimeId: "runtime-1",
    workspaceName: "contract",
};

const pairedStatus = {
    agents: [],
    channelId: "channel-1",
    machineName: "MacBook",
    projectId: "project-1",
    runtimeId: "runtime-1",
    status: "paired",
    workspaceName: "contract",
};

describe("Runtime descriptor decoding contracts", () => {
    it("Given a Runtime list, When it is decoded, Then its Agents are available", () => {
        const decoded = decodeMobiusRuntimeList({ runtimes: [runtime] });
        expect(decoded[0]?.agents[0]?.id).toBe("codex");
    });

    it("Given a Runtime list from a Relay that still echoes retired fields, When it is decoded, Then it is accepted", () => {
        expect(() => decodeMobiusRuntimeList({ runtimes: [{ ...runtime, installableAgents: [] }] })).not.toThrow();
    });

    it("Given a paired status, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMobiusRuntimePairingStatus(pairedStatus);
        expect(decoded.status).toBe(MobiusRuntimePairingLifecycle.Paired);
    });

    it("Given a channel descriptor, When it is decoded, Then it is accepted", () => {
        expect(() => decodeMobiusChannelDescriptor(runtime)).not.toThrow();
    });
});
