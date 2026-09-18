import { decodeSessionPrepareCommand, SESSION_PREPARE_KIND, type SessionConfigOption } from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    createTestApplication,
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

const nativeMode: SessionConfigOption = {
    booleanValue: false,
    category: "mode",
    currentValue: "default",
    description: "Agent session mode",
    id: "mode",
    name: "Mode",
    type: "select",
    values: [
        {
            description: "Use the Agent default",
            groupId: "",
            groupName: "",
            name: "Default",
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
};

describe.sequential("Agent-native run settings", () => {
    it("Given an Agent exposes only its native mode, When the user opens run settings, Then Mobius does not invent model, effort, or permission controls", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare, [nativeMode]);

            fireEvent.click(
                await screen.findByRole("button", {
                    name: /Run settings: Default/,
                }),
            );
            expect(screen.getByRole("combobox", { name: "Mode" })).toBeTruthy();
            expect(screen.queryByRole("combobox", { name: "Permissions" })).toBeNull();
            expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
            expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
            expect(screen.queryByText("Required")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
