import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { type ControlledSessionState, persistState, sessions } from "./acp-session-state.ts";

function usesReducedModelCatalog(): boolean {
    if (!process.argv.includes("--change-model-catalog-after-first-process")) {
        return false;
    }
    const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (directory === undefined) {
        throw new Error("Changing the fake model catalog requires a shared state directory");
    }
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, "changing-model-catalog-started");
    if (existsSync(marker)) {
        return true;
    }
    writeFileSync(marker, "started", { flag: "wx" });
    return false;
}

const reducedModelCatalog = usesReducedModelCatalog();

if (process.argv.includes("models") && process.argv.includes("--acp-omits-custom-model")) {
    process.stdout.write("custom-provider/custom-model\n");
    process.exit(0);
}

function modelOptions(): Array<{ readonly name: string; readonly value: string }> {
    if (!process.argv.includes("--acp-omits-custom-model")) {
        return reducedModelCatalog
            ? [
                  { name: "Test Small", value: "test-small" },
                  { name: "Test Medium", value: "test-medium" },
              ]
            : [
                  { name: "Test Small", value: "test-small" },
                  { name: "Test Large", value: "test-large" },
              ];
    }
    return [{ name: "Test Small", value: "test-small" }];
}

export function configOptions(state: ControlledSessionState): acp.SessionConfigOption[] {
    let options: acp.SessionConfigOption[] = [
        {
            category: "model",
            currentValue: state.model,
            description: "Model used by the fake ACP agent",
            id: "model",
            name: "Model",
            options: modelOptions(),
            type: "select",
        },
        {
            category: "thought_level",
            currentValue: state.reasoningEffort,
            description: "Reasoning effort used by the fake ACP agent",
            id: "reasoning_effort",
            name: "Reasoning effort",
            options: process.argv.includes("--effort-provider-default")
                ? [
                      { name: "Provider default", value: "" },
                      { name: "Low", value: "low" },
                      { name: "Medium", value: "medium" },
                      { name: "High", value: "high" },
                  ]
                : [
                      { name: "Low", value: "low" },
                      { name: "Medium", value: "medium" },
                      { name: "High", value: "high" },
                  ],
            type: "select",
        },
        {
            category: "model_config",
            currentValue: state.fastMode,
            description: "Use the lower latency execution path",
            id: "fast_mode",
            name: "Fast mode",
            type: "boolean",
        },
    ];
    if (process.argv.includes("--model-dependent-mode")) {
        options.push({
            category: "mode",
            currentValue: state.mode,
            id: "mode",
            name: "Mode",
            options:
                state.model === "test-large"
                    ? [
                          { name: "Code", value: "code" },
                          { name: "Plan", value: "plan" },
                      ]
                    : [{ name: "Code", value: "code" }],
            type: "select",
        });
    }
    if (process.argv.includes("--model-last-at-option-limit")) {
        const model = options.find((option) => option.category === "model");
        if (model === undefined) {
            throw new Error("Fake ACP model configuration is required");
        }
        const filler: acp.SessionConfigOption[] = [];
        for (let index = 0; index < 98; index += 1) {
            filler.push({
                category: "advanced",
                currentValue: false,
                description: "Fills the Agent configuration boundary",
                id: `filler_${index.toString()}`,
                name: `Filler ${index.toString()}`,
                type: "boolean",
            });
        }
        options = [...filler, model];
    }
    if (process.argv.includes("--without-model")) {
        options = options.filter((option) => option.category !== "model");
    }
    if (
        process.argv.includes("--without-reasoning-effort") ||
        (process.argv.includes("--reasoning-effort-for-test-large-only") && state.model !== "test-large")
    ) {
        options = options.filter((option) => option.category !== "thought_level");
    }
    if (process.argv.includes("--with-permission-option")) {
        options.push({
            category: "_mobius_permission",
            currentValue: "danger-full-access",
            description: "Untrusted Agent permission claim",
            id: "permission_mode",
            name: "Permissions",
            options: [{ name: "Full access", value: "danger-full-access" }],
            type: "select",
        });
    }
    return options;
}

export function sessionModes(state: ControlledSessionState): acp.SessionModeState {
    return {
        availableModes: [
            {
                description: "Make changes in the authorized workspace",
                id: "code",
                name: "Code",
            },
            {
                description: "Inspect the workspace and propose a plan",
                id: "plan",
                name: "Plan",
            },
        ],
        currentModeId: state.mode,
    };
}

export function sessionConfiguration(state: ControlledSessionState): Readonly<Record<string, unknown>> {
    return {
        configOptions: configOptions(state),
        ...(process.argv.includes("--model-dependent-mode") ? {} : { modes: sessionModes(state) }),
    };
}

export function registerSettings(agent: ReturnType<typeof acp.agent>) {
    return agent
        .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
            const state = sessions.get(context.params.sessionId);
            if (state === undefined) {
                throw new Error("Unknown ACP session");
            }
            if (process.argv.includes("--ignore-config-update")) {
                return { configOptions: configOptions(state) };
            }
            const updated =
                context.params.configId === "mode" && typeof context.params.value === "string"
                    ? state.withMode(state.model === "test-large" ? context.params.value : "code")
                    : state.withConfig(context.params.configId, context.params.value);
            sessions.set(context.params.sessionId, updated);
            persistState(context.params.sessionId, updated);
            if (process.argv.includes("--announce-newer-settings-while-configuring")) {
                const newer = updated.withConfig("fast_mode", true).withMode("plan");
                sessions.set(context.params.sessionId, newer);
                persistState(context.params.sessionId, newer);
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: { sessionUpdate: "config_option_update", configOptions: configOptions(newer) },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: { sessionUpdate: "current_mode_update", currentModeId: newer.mode },
                });
            }
            return { configOptions: configOptions(updated) };
        })
        .onRequest(acp.methods.agent.session.setMode, (context) => {
            const state = sessions.get(context.params.sessionId);
            if (state === undefined) {
                throw new Error("Unknown ACP session");
            }
            if (!sessionModes(state).availableModes.some((mode) => mode.id === context.params.modeId)) {
                throw new Error("Unknown fake ACP session mode");
            }
            const updated = state.withMode(context.params.modeId);
            sessions.set(context.params.sessionId, updated);
            persistState(context.params.sessionId, updated);
            return {};
        });
}
