import {
    decodeMobiusChannelDescriptor,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairingStatus,
    MobiusProtocolError,
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
    it("Given a Runtime list without installable Agents, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMobiusRuntimeList({ runtimes: [runtime] });
        expect(decoded[0]?.installableAgents).toEqual([]);
    });

    it("Given a Runtime list with a legacy installable Agents directory, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMobiusRuntimeList({
            runtimes: [{ ...runtime, installableAgents: [] }],
        });
        expect(decoded[0]?.installableAgents).toEqual([]);
    });

    it("Given a Runtime with an invalid installable Agents directory, When it is decoded, Then it is rejected", () => {
        expect(() => decodeMobiusRuntimeList({ runtimes: [{ ...runtime, installableAgents: 7 }] })).toThrow(
            MobiusProtocolError,
        );
    });

    it("Given a paired status without installable Agents, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMobiusRuntimePairingStatus(pairedStatus);
        expect(decoded.status).toBe(MobiusRuntimePairingLifecycle.Paired);
    });

    it("Given a paired status with a legacy installable Agents directory, When it is decoded, Then it is accepted", () => {
        const decoded = decodeMobiusRuntimePairingStatus({ ...pairedStatus, installableAgents: [] });
        expect(decoded.status).toBe(MobiusRuntimePairingLifecycle.Paired);
    });

    it("Given a channel descriptor without installable Agents, When it is decoded, Then it is accepted", () => {
        const channel = { ...runtime };
        delete (channel as { installableAgents?: unknown }).installableAgents;
        expect(() => decodeMobiusChannelDescriptor(channel)).not.toThrow();
    });
});
