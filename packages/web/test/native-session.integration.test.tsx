import {
    decodeNativeSessionCommand,
    decodeSessionPrepareCommand,
    encodeNativeSessionResult,
    NATIVE_SESSION_REQUEST_KIND,
    SESSION_PREPARE_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    createTestApplication,
    openPairedApplication,
    openReadyApplication,
    sendReadySession,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Native Session boundaries", () => {
    it("Given a conversation has multiple completed turns, When a user forks from its latest answer, Then the request binds the child to that terminal Turn", async ({
        signal,
    }) => {
        const paired = await openReadyApplication();

        try {
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
            const latest = await completeRenderedPrompt(
                paired.daemon,
                "Repeat the first answer verbatim",
                "The implementation plan is established.",
            );

            const latestAnswer = screen
                .getAllByRole("article", { name: "Message from Codex" })
                .find((article) => article.textContent?.includes("The implementation plan is established."));
            const matchingAnswers = screen
                .getAllByRole("article", { name: "Message from Codex" })
                .filter((article) => article.textContent?.includes("The implementation plan is established."));
            const latestMatchingAnswer = matchingAnswers.at(-1) ?? latestAnswer;
            if (latestMatchingAnswer === undefined) {
                throw new Error("Expected the latest completed answer");
            }
            fireEvent.click(
                within(latestMatchingAnswer).getByRole("button", {
                    name: "Fork conversation after this turn",
                }),
            );

            const fork = decodeNativeSessionCommand(await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND));
            expect(fork).toMatchObject({
                action: "fork-recorded",
                agentId: "codex",
                sessionId: first.sessionId,
                throughCommandId: latest.commandId,
            });
            if (fork.action !== "fork-recorded") {
                throw new Error("Expected a recorded Turn fork request");
            }
            paired.daemon.send(
                encodeNativeSessionResult({
                    action: "fork-recorded",
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
                () => window.location.pathname.includes(`/sessions/${encodeURIComponent(fork.targetSessionId)}`),
                signal,
            );
            expect(screen.queryByRole("button", { name: "Forking conversation" })).toBeNull();
            expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
            expect(window.location.pathname).toContain(`/sessions/${encodeURIComponent(fork.targetSessionId)}`);
        } finally {
            await paired.close();
        }
    });

    it("Given a native Session returns truncated assistant fragments for an existing Mobius conversation, When a user opens it again, Then each visible message stays singular and background synchronization stays healthy", async ({
        signal,
    }) => {
        const paired = await openReadyApplication();

        try {
            const preparation = paired.preparation;
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
                                activities: [],
                                content: [],
                                role: "assistant",
                                text: "Inspecting the workspace. ",
                            },
                            { activities: [], content: [], role: "assistant", text: "CLAUDE_FRAGMENTED_OK" },
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
            await paired.close();
        }
    });

    it("Given a native Session is opened, When the Web app reloads, Then its title and transcript are restored from the canonical Session", async () => {
        const paired = await openPairedApplication();

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
                    {
                        activities: [],
                        content: [],
                        role: "assistant" as const,
                        text: "Persisted native answer",
                    },
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
            createTestApplication();
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
            await paired.close();
        }
    });
});
