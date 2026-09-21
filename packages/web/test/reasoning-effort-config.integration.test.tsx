import {
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
    AGENT_SETTINGS_DISCOVER_KIND,
    decodeAgentSettingsDiscoverCommand,
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    encodeAgentSettingsDiscoveredEvent,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentOption } from "@/domain/channel";
import { openPairedApplication, sendReadySession, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

const discoveryCapabilities = {
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
    unstableForkSession: false,
};

function discoveryAgent(id: string, label: string): AgentOption {
    return new AgentOption(id, label, `/usr/local/bin/${id}`, "integration", discoveryCapabilities, true, true);
}

function sendDiscoveredNativeMode(agentId: string, requestId: string): string {
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "Codex",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "",
            modelSettingId: "",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
            unsupportedModelIds: [],
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
            },
        ],
        settingsRevision: "0".repeat(64),
    });
}

function modelValue(name: string, value: string) {
    return {
        description: `Use ${name}`,
        groupId: "",
        groupName: "",
        name,
        value,
    };
}

function sendDiscoveredModelSettings(agentId: string, requestId: string, model: string): string {
    const selectedModel = model.length === 0 ? "model-a" : model;
    const defaultEffortValues = [modelValue("Low", "low"), modelValue("Medium", "medium")];
    const selectedEffortValues =
        selectedModel === "model-b"
            ? [modelValue("Balanced", "balanced"), modelValue("High", "high")]
            : defaultEffortValues;
    const defaultEffort = defaultEffortValues[0];
    if (defaultEffort === undefined) {
        throw new Error("The test Agent effort settings are invalid");
    }
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "Codex",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
            unsupportedModelIds: [],
            valuesByModel: model.length === 0 ? {} : { [selectedModel]: selectedEffortValues },
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "model-a",
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: defaultEffort.value,
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values: defaultEffortValues,
            },
        ],
        settingsRevision: "1".repeat(64),
    });
}

function sendDiscoveredUnsupportedModel(agentId: string, requestId: string): string {
    const effortValues = [modelValue("Low", "low"), modelValue("Medium", "medium")];
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "Codex",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
            unsupportedModelIds: ["model-b"],
            valuesByModel: {},
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "model-a",
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: "low",
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values: effortValues,
            },
        ],
        settingsRevision: "5".repeat(64),
    });
}

function sendDiscoveredProviderDefaultEffortSettings(agentId: string, requestId: string): string {
    // A custom provider route reports the effort it will actually use as the
    // empty provider-default id rather than one of its own levels.
    const values = [modelValue("Provider default", ""), modelValue("Low", "low"), modelValue("High", "high")];
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "DeepSeek Harness",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
            unsupportedModelIds: [],
            valuesByModel: {},
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "model-a",
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: "",
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values,
            },
        ],
        settingsRevision: "2".repeat(64),
    });
}

function sendDiscoveredDeferredEffortSettings(agentId: string, requestId: string, model: string): string {
    const selectedModel = model.length === 0 ? "model-a" : model;
    if (model.length === 0 || selectedModel === "model-a") {
        return encodeAgentSettingsDiscoveredEvent({
            agentId,
            agentName: "DeepSeek Harness",
            agentVersion: "integration",
            kind: "agent.settings.discovered",
            modelEffort: {
                effortSettingId: "",
                modelSettingId: "model",
                resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
                unsupportedModelIds: [],
                valuesByModel: model.length === 0 ? {} : { [selectedModel]: [] },
            },
            requestId,
            settings: [
                {
                    booleanValue: false,
                    category: "model",
                    defaultValue: selectedModel,
                    description: "Execution model",
                    id: "model",
                    name: "Model",
                    type: "select",
                    values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
                },
            ],
            settingsRevision: "3".repeat(64),
        });
    }
    const effortValues = [modelValue("Balanced", "balanced"), modelValue("High", "high")];
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "DeepSeek Harness",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
            unsupportedModelIds: [],
            valuesByModel: { [selectedModel]: effortValues },
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: selectedModel,
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: "balanced",
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values: effortValues,
            },
        ],
        settingsRevision: "3".repeat(64),
    });
}

function sendDiscoveredDefaultModelEffort(agentId: string, requestId: string): string {
    const effortValues = [modelValue("Balanced", "balanced"), modelValue("High", "high")];
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "DeepSeek Harness",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
            unsupportedModelIds: [],
            valuesByModel: { "model-a": effortValues },
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "model-a",
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: "balanced",
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values: effortValues,
            },
        ],
        settingsRevision: "4".repeat(64),
    });
}

function sendDiscoveredCompleteModelSettings(agentId: string, requestId: string): string {
    const modelAEfforts = [modelValue("Low", "low"), modelValue("Medium", "medium")];
    const modelBEfforts = [modelValue("Balanced", "balanced"), modelValue("High", "high")];
    return encodeAgentSettingsDiscoveredEvent({
        agentId,
        agentName: "Codex",
        agentVersion: "integration",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "reasoning_effort",
            modelSettingId: "model",
            resolution: AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
            unsupportedModelIds: [],
            valuesByModel: {
                "model-a": modelAEfforts,
                "model-b": modelBEfforts,
            },
        },
        requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "model-a",
                description: "Execution model",
                id: "model",
                name: "Model",
                type: "select",
                values: [modelValue("Model A", "model-a"), modelValue("Model B", "model-b")],
            },
            {
                booleanValue: false,
                category: "thought_level",
                defaultValue: "low",
                description: "Reasoning effort",
                id: "reasoning_effort",
                name: "Reasoning effort",
                type: "select",
                values: modelAEfforts,
            },
        ],
        settingsRevision: "2".repeat(64),
    });
}

function groupedModelConfig(): readonly SessionConfigOption[] {
    return [
        {
            booleanValue: false,
            category: "model",
            currentValue: "deepseek-official/deepseek-v4-flash",
            description: "Execution model",
            id: "model",
            name: "Model",
            type: "select",
            values: [
                {
                    description: "Official DeepSeek route",
                    groupId: "deepseek-official",
                    groupName: "DeepSeek Official",
                    name: "DeepSeek V4 Flash",
                    value: "deepseek-official/deepseek-v4-flash",
                },
                {
                    description: "User-configured model",
                    groupId: "custom-provider",
                    groupName: "Custom Provider",
                    name: "GPT-5.5",
                    value: "custom-provider/gpt-5.5",
                },
                {
                    description: "User-configured model",
                    groupId: "custom-provider",
                    groupName: "Custom Provider",
                    name: "GPT-5.6 Sol",
                    value: "custom-provider/gpt-5.6-sol",
                },
            ],
        },
    ];
}

describe.sequential("Agent-native run settings", () => {
    it("Given an Agent advertises grouped models, When the user changes model, Then the picker preserves provider groups and sends the advertised value", async () => {
        const paired = await openPairedApplication();

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare, groupedModelConfig());

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: DeepSeek V4 Flash/ }));
            const modelPicker = screen.getByRole("combobox", { name: "Model" });
            fireEvent.pointerDown(modelPicker, { button: 0, pointerType: "mouse" });

            const officialModels = await screen.findByRole("group", { name: "DeepSeek Official" });
            expect(within(officialModels).getByRole("option", { name: "DeepSeek V4 Flash" })).toBeTruthy();
            const customModels = screen.getByRole("group", { name: "Custom Provider" });
            expect(
                within(customModels)
                    .getAllByRole("option")
                    .map((option) => (option.textContent ?? "").trim()),
            ).toEqual(["GPT-5.5", "GPT-5.6 Sol"]);

            fireEvent.click(within(customModels).getByRole("option", { name: "GPT-5.6 Sol" }));
            expect(decodeSessionConfigureCommand(await paired.daemon.receive(SESSION_CONFIGURE_KIND))).toMatchObject({
                agentId: "codex",
                configId: "model",
                sessionId: prepare.sessionId,
                value: "custom-provider/gpt-5.6-sol",
            });
        } finally {
            await paired.close();
        }
    });

    it("Given an Agent exposes only its native mode, When the user opens run settings, Then Mobius uses cached Agent settings instead of session preparation options", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            expect(discovery).toMatchObject({ agentId: "codex", kind: AGENT_SETTINGS_DISCOVER_KIND });
            paired.daemon.send(sendDiscoveredNativeMode(discovery.agentId, discovery.requestId));
            await sendReadySession(paired.daemon, prepare, []);

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
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);

            const mode = screen.getByRole("combobox", { name: "Mode" });
            fireEvent.pointerDown(mode, { button: 0, pointerType: "mouse" });
            fireEvent.click(await screen.findByRole("option", { name: "Plan" }));

            const input = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(input, { target: { value: "Use plan mode" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.sessionConfigurations).toEqual([
                {
                    booleanValue: false,
                    configId: "mode",
                    value: "plan",
                    valueType: "select",
                },
            ]);
        } finally {
            await paired.close();
        }
    });

    it("Given the default model itself exposes effort, When the user opens run settings, Then the picker is available without switching models", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            // The Agent reports the default model's own effort capability, so a
            // session that never switches models still offers the control.
            paired.daemon.send(sendDiscoveredDefaultModelEffort(discovery.agentId, discovery.requestId));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));

            const effort = await screen.findByRole("combobox", { name: "Reasoning effort" });
            expect(effort).toBeTruthy();
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);
        } finally {
            await paired.close();
        }
    });

    it("Given an Agent reports effort as the provider default, When the user opens run settings, Then the picker offers that default and the Agent's own levels", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            paired.daemon.send(sendDiscoveredProviderDefaultEffortSettings(discovery.agentId, discovery.requestId));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A, Provider default/ }));

            const effort = await screen.findByRole("combobox", { name: "Reasoning effort" });
            fireEvent.pointerDown(effort, { button: 0, pointerType: "mouse" });
            expect(await screen.findByRole("option", { name: "Provider default" })).toBeTruthy();
            expect(await screen.findByRole("option", { name: "High" })).toBeTruthy();

            fireEvent.click(screen.getByRole("option", { name: "High" }));
            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model A, High/ })).toBeTruthy();
            });
        } finally {
            await paired.close();
        }
    });

    it("Given effort is available only after model selection, When the user selects a model, Then Mobius fetches only that model's effort and snapshots the cached selections", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            expect(discovery.model).toBeUndefined();
            paired.daemon.send(sendDiscoveredModelSettings(discovery.agentId, discovery.requestId, ""));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));
            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));

            const selectedModel = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(selectedModel).toMatchObject({ agentId: "codex", model: "model-b" });
            paired.daemon.send(sendDiscoveredModelSettings(selectedModel.agentId, selectedModel.requestId, "model-b"));

            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model B, Balanced/ })).toBeTruthy();
            });
            expect(paired.daemon.available(SESSION_CONFIGURE_KIND)).toBe(0);

            const input = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(input, { target: { value: "Use the selected model" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.sessionConfigurations).toEqual([
                {
                    booleanValue: false,
                    configId: "model",
                    value: "model-b",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "reasoning_effort",
                    value: "balanced",
                    valueType: "select",
                },
            ]);
        } finally {
            await paired.close();
        }
    });

    it("Given a model becomes unsupported during selection, When discovery completes, Then Mobius falls back to a supported model", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            paired.daemon.send(sendDiscoveredModelSettings(discovery.agentId, discovery.requestId, ""));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));
            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));

            const selectedModel = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(selectedModel).toMatchObject({ agentId: "codex", model: "model-b" });
            paired.daemon.send(sendDiscoveredUnsupportedModel(selectedModel.agentId, selectedModel.requestId));

            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model A, Low/ })).toBeTruthy();
            });
            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            expect(screen.queryByRole("option", { name: "Model B" })).toBeNull();
        } finally {
            await paired.close();
        }
    });

    it("Given the default model has no effort setting, When the user switches to a model that exposes effort, Then the picker appears without a reload or protocol error", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            paired.daemon.send(sendDiscoveredDeferredEffortSettings(discovery.agentId, discovery.requestId, ""));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));
            expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();

            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));

            const selectedModel = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(selectedModel).toMatchObject({ agentId: "codex", model: "model-b" });
            paired.daemon.send(
                sendDiscoveredDeferredEffortSettings(selectedModel.agentId, selectedModel.requestId, "model-b"),
            );

            await waitFor(() => {
                expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeTruthy();
            });
            expect(
                screen.queryByText(/invalid_protocol_message: Received an invalid message from the relay/),
            ).toBeNull();

            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model A" }));
            const deselectedModel = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(deselectedModel).toMatchObject({ agentId: "codex", model: "model-a" });
            paired.daemon.send(
                sendDiscoveredDeferredEffortSettings(deselectedModel.agentId, deselectedModel.requestId, "model-a"),
            );
            await waitFor(() => {
                expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
            });

            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));
            await waitFor(() => {
                expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeTruthy();
            });
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);

            const input = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(input, { target: { value: "Use the selected model" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.sessionConfigurations).toEqual([
                {
                    booleanValue: false,
                    configId: "model",
                    value: "model-b",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "reasoning_effort",
                    value: "balanced",
                    valueType: "select",
                },
            ]);
        } finally {
            await paired.close();
        }
    });

    it("Given an Agent returns a complete model-to-effort map, When the user selects another model, Then Mobius uses the cached map without another discovery", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            paired.daemon.send(sendDiscoveredCompleteModelSettings(discovery.agentId, discovery.requestId));
            await sendReadySession(paired.daemon, prepare, []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));
            const model = screen.getByRole("combobox", { name: "Model" });
            fireEvent.pointerDown(model, { button: 0, pointerType: "mouse" });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));

            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model B, Balanced/ })).toBeTruthy();
            });
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);

            const input = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(input, { target: { value: "Use the selected model" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.sessionConfigurations).toEqual([
                {
                    booleanValue: false,
                    configId: "model",
                    value: "model-b",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "reasoning_effort",
                    value: "balanced",
                    valueType: "select",
                },
            ]);
        } finally {
            await paired.close();
        }
    });

    it("Given a non-default model's effort was cached, When the user reloads run settings, Then the cached effort survives the base rediscovery", async () => {
        const paired = await openPairedApplication({ agentSettingsDiscovery: true, sessionTurnConfiguration: true });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            paired.daemon.send(sendDiscoveredModelSettings(discovery.agentId, discovery.requestId, ""));
            await sendReadySession(paired.daemon, decodeSessionPrepareCommand(encodedPrepare), []);

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Model A/ }));
            fireEvent.pointerDown(screen.getByRole("combobox", { name: "Model" }), {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Model B" }));

            const selectedModel = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(selectedModel.model).toBe("model-b");
            paired.daemon.send(sendDiscoveredModelSettings(selectedModel.agentId, selectedModel.requestId, "model-b"));
            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model B, Balanced/ })).toBeTruthy();
            });

            // Reloading asks the Agent for its base capability again, and that reply names no model: it
            // describes only the Agent's own default effort. The model the user already selected still has
            // to render from the cache instead of costing a second lookup and a loading flash.
            fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
            const reloaded = decodeAgentSettingsDiscoverCommand(
                await paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
            );
            expect(reloaded.model).toBeUndefined();
            paired.daemon.send(sendDiscoveredModelSettings(reloaded.agentId, reloaded.requestId, ""));

            await waitFor(() => {
                expect(screen.getByRole("button", { name: /Run settings: Model B, Balanced/ })).toBeTruthy();
            });
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);
        } finally {
            await paired.close();
        }
    });

    it("Given a channel offers several discovery-capable Agents, When a conversation opens, Then Mobius discovers settings only for that conversation's Agent", async () => {
        const paired = await openPairedApplication({
            agents: [discoveryAgent("codex", "Codex"), discoveryAgent("hermes", "Hermes Agent")],
        });

        try {
            const [encodedDiscovery, encodedPrepare] = await Promise.all([
                paired.daemon.receive(AGENT_SETTINGS_DISCOVER_KIND),
                paired.daemon.receive(SESSION_PREPARE_KIND),
            ]);
            const discovery = decodeAgentSettingsDiscoverCommand(encodedDiscovery);
            const prepare = decodeSessionPrepareCommand(encodedPrepare);
            expect(discovery).toMatchObject({ agentId: "codex", kind: AGENT_SETTINGS_DISCOVER_KIND });
            paired.daemon.send(sendDiscoveredNativeMode(discovery.agentId, discovery.requestId));
            await sendReadySession(paired.daemon, prepare, []);

            await screen.findByRole("button", { name: /Run settings: Default/ });
            expect(paired.daemon.available(AGENT_SETTINGS_DISCOVER_KIND)).toBe(0);
        } finally {
            await paired.close();
        }
    });
});
