import { cleanup, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeRuntimeTransport } from "@/services/runtime-transport";
import {
    createTestApplication,
    openPairedApplication,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Channel access boundaries", () => {
    it("Given a Standalone Project credential, When Runtime administration opens, Then channel-scoped device grants are not advertised", async () => {
        const paired = await openPairedApplication();
        try {
            await screen.findByRole("heading", { level: 1, name: "Local Agents" });
            expect(screen.queryByRole("link", { name: "Access from other devices" })).toBeNull();
        } finally {
            await paired.close();
        }
    });

    it("Given a saved Channel credential has no authority, When Web opens the Channel, Then the obsolete credential is rejected", async () => {
        const paired = await openPairedApplication();

        try {
            cleanup();
            await closeRuntimeTransport();
            window.localStorage.clear();
            window.localStorage.setItem(
                `mobius:channel-credential:${paired.channelId}`,
                JSON.stringify({
                    hostToken: paired.credential.hostToken,
                    projectId: paired.credential.projectId,
                }),
            );
            window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
            createTestApplication();

            expect(await screen.findByText("The saved channel credential is invalid.")).toBeTruthy();
        } finally {
            await paired.close();
        }
    });
});
