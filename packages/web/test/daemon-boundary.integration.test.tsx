import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
    completeRenderedPrompt,
    openReadyApplication,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();
it("Given the real Standalone app and a controlled daemon, When a user sends a prompt, Then its reply appears through the real relay", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T00:00:00Z"), toFake: ["Date"] });
    const paired = await openReadyApplication();
    try {
        await completeRenderedPrompt(paired.daemon, "Check the workspace", "The workspace is ready.");
        expect(screen.getByText("The workspace is ready.")).toBeTruthy();
    } finally {
        await paired.close();
        vi.useRealTimers();
    }
});
