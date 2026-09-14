import {
    decodeNativeSessionCommand,
    decodeNativeSessionTurnForkCommand,
    decodeSessionPrepareCommand,
    encodeNativeSessionResult,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_TURN_FORK_KIND,
    SESSION_PREPARE_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Native Session boundaries", () => {
    it("Given a conversation has multiple completed turns, When a user forks from the first answer, Then a new conversation opens with context ending at that turn", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            const first = await completeRenderedPrompt(
                paired.daemon,
                "Establish the implementation plan",
                "The implementation plan is established.",
            );
            await completeRenderedPrompt(
                paired.daemon,
                "Apply the second-stage changes",
                "The second-stage changes are applied.",
            );
            await completeRenderedPrompt(
                paired.daemon,
                "Repeat the first answer verbatim",
                "The implementation plan is established.",
            );

            const firstAnswer = screen
                .getAllByRole("article", { name: "Message from Codex" })
                .find((article) => article.textContent?.includes("The implementation plan is established."));
            if (firstAnswer === undefined) {
                throw new Error("Expected the first completed answer");
            }
            fireEvent.click(
                within(firstAnswer).getByRole("button", {
                    name: "Fork conversation after this turn",
                }),
            );

            const fork = decodeNativeSessionTurnForkCommand(await paired.daemon.receive(NATIVE_SESSION_TURN_FORK_KIND));
            expect(fork).toMatchObject({
                agentId: "codex",
                messageId: `agent-${first.commandId}`,
                messageOccurrence: 1,
                sessionId: first.sessionId,
                sourceCommandId: first.commandId,
            });
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "fork",
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                        messages: [
                            { role: "user", text: "Establish the implementation plan" },
                            { role: "assistant", text: "The implementation plan is established." },
                        ],
                        status: "available",
                        truncated: false,
                    },
                    kind: "native.session.result",
                    ready: {
                        additionalDirectories: [],
                        agentId: fork.agentId,
                        agentName: "Codex",
                        agentVersion: "integration",
                        capabilities: {
                            additionalDirectories: true,
                            audioPrompt: false,
                            closeSession: true,
                            deleteSession: true,
                            embeddedContextPrompt: true,
                            imagePrompt: true,
                            listSessions: true,
                            loadSession: true,
                            promptQueueing: false,
                            resumeSession: true,
                            steering: false,
                            unstableForkSession: true,
                        },
                        commands: [],
                        configOptions: [],
                        directoryId: fork.directoryId,
                        directoryLabel: "mobius",
                        kind: "session.ready",
                        requestId: fork.requestId,
                        restored: true,
                        sessionId: fork.targetSessionId,
                    },
                    requestId: fork.requestId,
                    sessionId: fork.sessionId,
                    targetSessionId: fork.targetSessionId,
                    title: fork.title,
                }),
            );

            await waitForDocumentState(
                () => screen.queryByRole("region", { name: "Previous conversation history" }) !== null,
                signal,
            );
            expect(screen.queryByRole("button", { name: "Forking conversation" })).toBeNull();
            expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
            expect(window.location.pathname).toContain(`/sessions/${encodeURIComponent(fork.targetSessionId)}`);
            expect(screen.getByText("The implementation plan is established.")).toBeTruthy();
            expect(screen.queryByText("The second-stage changes are applied.")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a native Session returns truncated assistant fragments for an existing Mobius conversation, When a user opens it again, Then each visible message stays singular and background synchronization stays healthy", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            await completeRenderedPrompt(
                paired.daemon,
                "Explain the existing workspace",
                "Inspecting the workspace. CLAUDE_FRAGMENTED_OK",
            );

            const sessionsButton = await screen.findByRole("button", {
                name: "Local sessions",
            });
            await waitFor(() => expect(sessionsButton.hasAttribute("disabled")).toBe(false));
            fireEvent.click(sessionsButton);
            const sessionsDialog = await screen.findByRole("dialog", {
                name: "Local sessions",
            });
            fireEvent.click(within(sessionsDialog).getByRole("button", { name: "Codex" }));
            const listRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "list",
                    capabilities: {
                        additionalDirectories: true,
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: true,
                        embeddedContextPrompt: true,
                        imagePrompt: true,
                        listSessions: true,
                        loadSession: true,
                        promptQueueing: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: true,
                    },
                    entries: [
                        {
                            additionalDirectories: [],
                            directoryId: preparation.directoryId,
                            directoryLabel: "/workspace/existing",
                            entryId: "existing-native-session",
                            title: "Existing native conversation",
                            updatedAt: "2026-09-06T00:00:00.000Z",
                        },
                    ],
                    kind: "native.session.result",
                    nextCursor: null,
                    requestId: listRequest.requestId,
                    sessionId: listRequest.sessionId,
                }),
            );
            fireEvent.click(
                await within(sessionsDialog).findByRole("button", {
                    name: "Open Existing native conversation",
                }),
            );
            const openRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            if (openRequest.action !== "import") {
                throw new Error("Expected a native Session import request");
            }
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "import",
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                        messages: [
                            {
                                role: "assistant",
                                text: "Inspecting the workspace. ",
                            },
                            { role: "assistant", text: "CLAUDE_FRAGMENTED_OK" },
                        ],
                        status: "available",
                        truncated: true,
                    },
                    kind: "native.session.result",
                    ready: {
                        additionalDirectories: [],
                        agentId: "codex",
                        agentName: "Codex",
                        agentVersion: "integration",
                        capabilities: {
                            additionalDirectories: true,
                            audioPrompt: false,
                            closeSession: true,
                            deleteSession: true,
                            embeddedContextPrompt: true,
                            imagePrompt: true,
                            listSessions: true,
                            loadSession: true,
                            promptQueueing: false,
                            resumeSession: true,
                            steering: false,
                            unstableForkSession: true,
                        },
                        commands: [],
                        configOptions: [],
                        directoryId: preparation.directoryId,
                        directoryLabel: "/workspace/existing",
                        kind: "session.ready",
                        requestId: openRequest.requestId,
                        restored: true,
                        sessionId: preparation.sessionId,
                    },
                    requestId: openRequest.requestId,
                    sessionId: openRequest.sessionId,
                    targetSessionId: openRequest.targetSessionId,
                    title: "Existing native conversation",
                }),
            );

            await waitForDocumentState(() => {
                const transcript = screen.queryByRole("log");
                if (transcript === null) {
                    return false;
                }
                return (
                    within(transcript).queryAllByText("Explain the existing workspace").length === 1 &&
                    within(transcript).queryAllByText(/CLAUDE_FRAGMENTED_OK/).length === 1 &&
                    screen.queryAllByText(/history_sync_failed:/).length === 0
                );
            }, signal);
            const transcript = screen.getByRole("log");
            expect(within(transcript).getAllByText("Explain the existing workspace")).toHaveLength(1);
            expect(within(transcript).getAllByText(/CLAUDE_FRAGMENTED_OK/)).toHaveLength(1);
            expect(screen.queryAllByText(/history_sync_failed:/)).toHaveLength(0);
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent has saved history with image references, When a user previews that session, Then the Web app shows only a safe recent transcript", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);
            await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            const sessionsButton = await screen.findByRole("button", {
                name: "Local sessions",
            });
            await waitFor(() => expect(sessionsButton.hasAttribute("disabled")).toBe(false));
            fireEvent.click(sessionsButton);
            const sessionsDialog = await screen.findByRole("dialog", {
                name: "Local sessions",
            });
            fireEvent.click(within(sessionsDialog).getByRole("button", { name: "Codex" }));

            const listRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            expect(listRequest.action).toBe("list");
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "list",
                    capabilities: {
                        additionalDirectories: true,
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: true,
                        embeddedContextPrompt: true,
                        imagePrompt: true,
                        listSessions: true,
                        loadSession: true,
                        promptQueueing: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: true,
                    },
                    entries: [
                        {
                            additionalDirectories: [],
                            directoryId: "saved-project",
                            directoryLabel: "/workspace/saved-project",
                            entryId: "saved-session",
                            title: "Saved integration conversation",
                            updatedAt: "2026-09-06T00:00:00.000Z",
                        },
                    ],
                    kind: "native.session.result",
                    nextCursor: null,
                    requestId: listRequest.requestId,
                    sessionId: listRequest.sessionId,
                }),
            );

            const savedSession = await within(sessionsDialog).findByRole("button", {
                name: "Open Saved integration conversation",
            });
            fireEvent.click(savedSession);
            const previewRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            expect(previewRequest).toMatchObject({
                action: "import",
                directoryId: "saved-project",
                entryId: "saved-session",
            });
            if (previewRequest.action !== "import") {
                throw new Error("Expected an import request for session preview");
            }
            const imageData =
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "preview",
                    entryId: "saved-session",
                    history: {
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                        messages: [
                            { role: "user", text: "Older message outside the preview" },
                            ...Array.from({ length: 9 }, (_, index) => ({
                                role: "assistant" as const,
                                text: `Recent answer ${index.toString()}`,
                            })),
                            {
                                role: "user",
                                text: `Selected image [@image](data:image/png;base64,${imageData}) [@image](https://example.com/private.png)`,
                            },
                            {
                                role: "assistant",
                                text: "The screenshot is attached.",
                                images: [{ data: imageData, mimeType: "image/png", name: "Agent screenshot" }],
                            },
                        ],
                        status: "available",
                        truncated: false,
                    },
                    kind: "native.session.result",
                    reason: "continuation_unavailable",
                    requestId: previewRequest.requestId,
                    sessionId: previewRequest.sessionId,
                    targetSessionId: previewRequest.targetSessionId,
                    title: "Saved integration conversation",
                }),
            );

            await waitForDocumentState(
                () => within(sessionsDialog).queryByRole("region", { name: "Previous conversation history" }) !== null,
                signal,
            );
            const history = within(sessionsDialog).getByRole("region", {
                name: "Previous conversation history",
            });
            expect(history.textContent).toContain("Showing the last 10 messages");
            expect(history.textContent).not.toContain("Older message outside the preview");
            expect(history.textContent).toContain("Image unavailable");
            expect(history.textContent).not.toContain("private.png");
            expect(history.textContent).not.toContain("base64");
            const image = within(history).getByAltText("Image 1");
            expect(image.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
            const agentImage = within(history).getByAltText("Agent screenshot");
            expect(agentImage.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
            expect(history.querySelector('img[src^="http"]')).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a native Session is opened, When the Web app reloads, Then its title and transcript are restored from the canonical Session", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);
            const sessionsButton = await screen.findByRole("button", {
                name: "Local sessions",
            });
            await waitFor(() => expect(sessionsButton.hasAttribute("disabled")).toBe(false));
            fireEvent.click(sessionsButton);
            const sessionsDialog = await screen.findByRole("dialog", {
                name: "Local sessions",
            });
            fireEvent.click(within(sessionsDialog).getByRole("button", { name: "Codex" }));
            const listRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "list",
                    capabilities: {
                        additionalDirectories: true,
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: true,
                        embeddedContextPrompt: true,
                        imagePrompt: true,
                        listSessions: true,
                        loadSession: true,
                        promptQueueing: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: true,
                    },
                    entries: [
                        {
                            additionalDirectories: [],
                            directoryId: "saved-project",
                            directoryLabel: "/workspace/saved-project",
                            entryId: "persistent-native-session",
                            title: "Persistent native title",
                            updatedAt: "2026-09-06T00:00:00.000Z",
                        },
                    ],
                    kind: "native.session.result",
                    nextCursor: null,
                    requestId: listRequest.requestId,
                    sessionId: listRequest.sessionId,
                }),
            );
            fireEvent.click(
                await within(sessionsDialog).findByRole("button", {
                    name: "Open Persistent native title",
                }),
            );
            const openRequest = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            if (openRequest.action !== "import") {
                throw new Error("Expected a native Session import request");
            }
            const nativeHistory = {
                coveredCommandIds: [],
                coveredMessageIds: [],
                messages: [
                    { role: "user" as const, text: "Persisted native question" },
                    { role: "assistant" as const, text: "Persisted native answer" },
                ],
                status: "available" as const,
                truncated: false,
            };
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "import",
                    history: nativeHistory,
                    kind: "native.session.result",
                    ready: {
                        additionalDirectories: [],
                        agentId: "codex",
                        agentName: "Codex",
                        agentVersion: "integration",
                        capabilities: {
                            additionalDirectories: true,
                            audioPrompt: false,
                            closeSession: true,
                            deleteSession: true,
                            embeddedContextPrompt: true,
                            imagePrompt: true,
                            listSessions: true,
                            loadSession: true,
                            promptQueueing: false,
                            resumeSession: true,
                            steering: false,
                            unstableForkSession: true,
                        },
                        commands: [],
                        configOptions: [],
                        directoryId: openRequest.directoryId,
                        directoryLabel: "/workspace/saved-project",
                        kind: "session.ready",
                        requestId: openRequest.requestId,
                        restored: true,
                        sessionId: openRequest.targetSessionId,
                    },
                    requestId: openRequest.requestId,
                    sessionId: openRequest.sessionId,
                    targetSessionId: openRequest.targetSessionId,
                    title: "Persistent native title",
                }),
            );
            await screen.findByRole("heading", {
                level: 1,
                name: "Persistent native title",
            });
            await screen.findByText("Persisted native answer");
            expect(window.location.pathname).toBe(
                `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(openRequest.targetSessionId)}`,
            );

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(openRequest.targetSessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            await screen.findByRole("heading", {
                level: 1,
                name: "Persistent native title",
            });
            expect(await screen.findByText("Persisted native question")).toBeTruthy();
            expect(await screen.findByText("Persisted native answer")).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
