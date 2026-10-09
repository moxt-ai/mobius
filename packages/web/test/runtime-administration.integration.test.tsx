import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { openPairedApplication, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();
it("Given a paired Runtime, When a user opens Mobius Web, Then they manage Agents and machines without a duplicate chat workspace", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T00:00:00Z"), toFake: ["Date"] });
    const paired = await openPairedApplication();
    try {
        await screen.findByRole("heading", { name: "Local Agents" });
        expect(screen.queryByRole("combobox", { name: "Message the local agent" })).toBeNull();
        expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Local sessions" })).toBeNull();
        fireEvent.click(screen.getByRole("link", { name: "Local machines" }));
        await screen.findByRole("heading", { name: "Local machines" });
        expect(screen.queryByText("Open chat")).toBeNull();
    } finally {
        await paired.close();
        vi.useRealTimers();
    }
});
