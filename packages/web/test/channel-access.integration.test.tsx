import { decodeSessionPrepareCommand, SESSION_PREPARE_KIND } from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    createTestApplication,
    openPairedApplication,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Channel access boundaries", () => {
    it("Given an owned paired Channel, When device access is opened from the conversation sidebar, Then it appears outside Agent settings", async () => {
        const paired = await openPairedApplication({
            path: (channelId) => `/channels/${encodeURIComponent(channelId)}/settings`,
        });
        const accessPath = `/channels/${encodeURIComponent(paired.channelId)}/access`;

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            expect(
                screen.queryByRole("button", {
                    name: "Create one-time access link",
                }),
            ).toBeNull();

            fireEvent.click(screen.getByRole("link", { name: "Access from other devices" }));

            await screen.findByRole("heading", {
                level: 1,
                name: "Access from other devices",
            });
            expect(window.location.pathname).toBe(accessPath);
            expect(
                await screen.findByRole("button", {
                    name: "Create one-time access link",
                }),
            ).toBeTruthy();
        } finally {
            await paired.close();
        }
    });

    it("Given an owned paired Channel, When its one-time access link is opened in another browser, Then that browser receives revocable access without a Mobius account", async () => {
        const paired = await openPairedApplication({
            path: (channelId) => `/channels/${encodeURIComponent(channelId)}/access`,
        });
        const accessPath = `/channels/${encodeURIComponent(paired.channelId)}/access`;

        try {
            await screen.findByRole("heading", {
                level: 1,
                name: "Access from other devices",
            });
            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Create one-time access link",
                }),
            );
            const accessLinkInput = await screen.findByRole("textbox", {
                name: "One-time access link",
            });
            const accessLink = accessLinkInput.getAttribute("value") ?? "";
            expect(accessLink).toContain(`/channels/${encodeURIComponent(paired.channelId)}#access=`);
            expect(accessLink).not.toContain(paired.credential.hostToken);

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            window.history.replaceState(null, "", accessLink);
            createTestApplication();

            const linkedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, linkedPreparation);
            await screen.findByRole("combobox", { name: "Message the local agent" });
            expect(window.location.hash).toBe("");
            const linkedCredential = window.localStorage.getItem(`mobius:channel-credential:${paired.channelId}`);
            expect(linkedCredential).not.toBeNull();
            expect(linkedCredential).not.toContain(paired.credential.hostToken);

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            saveBrowserCredential(paired.channelId, paired.credential);
            window.history.replaceState(null, "", accessPath);
            createTestApplication();

            const linkedDevices = await screen.findByRole("list", {
                name: "Linked devices",
            });
            expect(within(linkedDevices).getAllByRole("listitem")).toHaveLength(1);
            fireEvent.click(
                within(linkedDevices).getByRole("button", {
                    name: /Revoke linked device/,
                }),
            );
            await waitFor(() => {
                expect(screen.getByText("No other devices currently have access.")).toBeTruthy();
            });

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            if (linkedCredential === null) {
                throw new Error("Expected a linked browser credential");
            }
            window.localStorage.setItem(`mobius:channel-credential:${paired.channelId}`, linkedCredential);
            window.history.replaceState(null, "", accessPath);
            createTestApplication();

            expect(
                await screen.findByText("unauthorized: A valid pairing or channel credential is required"),
            ).toBeTruthy();

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            saveBrowserCredential(paired.channelId, paired.credential);
            window.history.replaceState(null, "", accessPath);
            createTestApplication();

            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Create one-time access link",
                }),
            );
            const renewedAccessLink = (
                await screen.findByRole("textbox", {
                    name: "One-time access link",
                })
            ).getAttribute("value");
            if (renewedAccessLink === null) {
                throw new Error("Expected a renewed access link");
            }

            cleanup();
            await closeMobiusTransport();
            window.localStorage.setItem(`mobius:channel-credential:${paired.channelId}`, linkedCredential);
            window.history.replaceState(null, "", renewedAccessLink);
            createTestApplication();

            await screen.findByRole("combobox", { name: "Message the local agent" });
            expect(window.location.hash).toBe("");
            expect(window.localStorage.getItem(`mobius:channel-credential:${paired.channelId}`)).not.toBe(
                linkedCredential,
            );
        } finally {
            await paired.close();
        }
    });

    it("Given a one-time access link opens an existing Session, When the linked browser sends a follow-up, Then the local Agent response appears", async () => {
        const paired = await openPairedApplication();

        try {
            const ownerPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, ownerPreparation);
            await completeRenderedPrompt(
                paired.daemon,
                "Remember this conversation before I link another browser",
                "This conversation is ready on another browser.",
            );

            fireEvent.click(screen.getByRole("link", { name: "Access from other devices" }));
            await screen.findByRole("heading", { level: 1, name: "Access from other devices" });
            fireEvent.click(await screen.findByRole("button", { name: "Create one-time access link" }));
            const accessLink = (
                await screen.findByRole("textbox", {
                    name: "One-time access link",
                })
            ).getAttribute("value");
            if (accessLink === null) {
                throw new Error("Expected a one-time linked-browser access URL");
            }

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            window.history.replaceState(null, "", accessLink);
            createTestApplication();

            const linkedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(linkedPreparation.sessionId).toBe(ownerPreparation.sessionId);
            await sendReadySession(paired.daemon, linkedPreparation);
            await screen.findByText("This conversation is ready on another browser.");
            await completeRenderedPrompt(
                paired.daemon,
                "Continue from the linked browser",
                "The linked browser can continue this Session.",
            );

            expect(screen.queryByText(/owner_access_required/u)).toBeNull();
        } finally {
            await paired.close();
        }
    });
});
