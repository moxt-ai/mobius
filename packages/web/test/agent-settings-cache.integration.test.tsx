import {
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
    AGENT_SETTINGS_DISCOVER_KIND,
    decodeAgentSettingsDiscoverCommand,
    decodeSessionPrepareCommand,
    encodeAgentSettingsDiscoveredEvent,
    SESSION_PREPARE_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { dataTestId } from "@/data-testid";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    createTestApplication,
    openPairedApplication,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

function discoveredModeSettings(agentId: string, requestId: string, modeName: string): string {
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "Codex",
        agentVersion: "codex 0.153.0",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "",
            modelSettingId: "",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
            valuesByModel: {},
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "mode",
                defaultValue: "default",
                description: "Agent session mode",
                id: "mode",
                name: "Mode",
                type: "select",
                values: [
                    {
                        description: "Use the Agent default",
                        groupId: "",
                        groupName: "",
                        name: modeName,
                        value: "default",
                    },
                    {
                        description: "Plan before editing",
                        groupId: "",
                        groupName: "",
                        name: "Plan",
                        value: "plan",
                    },
                ],
            },
        ],
        settingsRevision: "7".repeat(64),
    });
}

describe.sequential("Persisted Agent settings", () => {
    it("Given a user already loaded Agent settings, When the Web app reloads, Then run settings open from the persisted cache without rediscovering them", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            paired.daemon.send(discoveredModeSettings(discovery.agentId, discovery.requestId, "Default"));
            await sendReadySession(paired.daemon, decodeSessionPrepareCommand(encodedPrepare), []);
            fireEvent.click(await screen.findByTestId(dataTestId.runSettingsTrigger));
            expect(await screen.findByRole("combobox", { name: "Mode" })).toBeTruthy();

            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            await sendReadySession(
                paired.daemon,
                decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND)),
                [],
            );

            fireEvent.click(await screen.findByTestId(dataTestId.runSettingsTrigger));
            expect(await screen.findByRole("combobox", { name: "Mode" })).toBeTruthy();
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);
        } finally {
            await paired.close();
        }
    });
});
