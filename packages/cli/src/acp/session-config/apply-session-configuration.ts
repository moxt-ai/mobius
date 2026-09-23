import { randomUUID } from "node:crypto";
import type { SessionConfigOption, SessionConfigurationSelection } from "@moxt-ai/mobius-protocol";
import { applyAgentLaunchSettings } from "../../agent-catalog/agent-settings-adapter.ts";
import type { AcpAgentDefinition } from "../../agent-catalog/local-agent.ts";
import type { AuditStore } from "../../audit/audit-store.ts";
import { AcpExecutionError, type AcpSessionManager } from "../session-manager.ts";

function invalidSessionConfiguration(message: string): AcpExecutionError {
    return new AcpExecutionError(message, {}, "invalid_session_configuration");
}

export function agentForSessionConfiguration(
    agent: AcpAgentDefinition,
    selections: readonly SessionConfigurationSelection[],
): ReturnType<typeof applyAgentLaunchSettings> {
    try {
        return applyAgentLaunchSettings(agent, selections);
    } catch (error) {
        if (error instanceof Error) {
            throw invalidSessionConfiguration(error.message);
        }
        throw error;
    }
}

function validateSessionConfigurationSelection(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): void {
    if (option.type !== selection.valueType) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} changed type`);
    }
    if (option.type === "boolean") {
        if (selection.value.length > 0) {
            throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an invalid value`);
        }
        return;
    }
    if (selection.booleanValue) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an invalid value`);
    }
    if (!option.values.some((value) => value.value === selection.value)) {
        throw invalidSessionConfiguration(`The Agent setting ${selection.configId} has an unavailable value`);
    }
}

function sessionConfigurationSelectionIsAvailable(
    option: SessionConfigOption,
    selection: SessionConfigurationSelection,
): boolean {
    if (option.type !== selection.valueType) {
        return false;
    }
    if (option.type === "boolean") {
        return selection.value.length === 0;
    }
    return !selection.booleanValue && option.values.some((value) => value.value === selection.value);
}

function sessionConfigurationMatches(option: SessionConfigOption, selection: SessionConfigurationSelection): boolean {
    validateSessionConfigurationSelection(option, selection);
    return option.type === "boolean"
        ? option.booleanValue === selection.booleanValue
        : option.currentValue === selection.value;
}

function sessionConfigurationPriority(
    selection: SessionConfigurationSelection,
    options: readonly SessionConfigOption[],
): number {
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (selection.configId === "model" || option?.category === "model") {
        return 0;
    }
    if (selection.configId === "reasoning_effort" || option?.category === "thought_level") {
        return 1;
    }
    if (option?.category === "model_config") {
        return 2;
    }
    return 3;
}

export function assertAppliedSessionConfiguration(
    options: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
): void {
    const selectionsById = new Map(selections.map((selection) => [selection.configId, selection]));
    for (const option of options) {
        const selection = selectionsById.get(option.id);
        if (selection === undefined || !sessionConfigurationSelectionIsAvailable(option, selection)) {
            continue;
        }
        if (!sessionConfigurationMatches(option, selection)) {
            throw invalidSessionConfiguration(`The Turn configuration does not match Agent setting ${option.id}`);
        }
    }
}

function unavailableSessionConfigurationCategory(selection: SessionConfigurationSelection): string {
    if (selection.configId === "model") {
        return "model";
    }
    if (selection.configId === "reasoning_effort") {
        return "thought_level";
    }
    return "unknown";
}

async function applySessionConfigurationSelection(
    sessions: AcpSessionManager,
    audit: AuditStore,
    options: readonly SessionConfigOption[],
    selection: SessionConfigurationSelection,
    agent: AcpAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    commandId: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    const option = options.find((candidate) => candidate.id === selection.configId);
    if (option === undefined) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            unavailableSessionConfigurationCategory(selection),
            "setting_unavailable",
        );
        return options;
    }
    if (option.type !== selection.valueType) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "setting_schema_mismatch",
        );
        return options;
    }
    if (
        (option.type === "boolean" && selection.value.length > 0) ||
        (option.type === "select" && selection.booleanValue)
    ) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "selection_schema_mismatch",
        );
        return options;
    }
    if (option.type === "select" && !option.values.some((value) => value.value === selection.value)) {
        warnIgnoredSetting(
            audit,
            "session_configuration_setting_ignored",
            commandId,
            sessionId,
            agent.id,
            selection,
            option.category,
            "value_unavailable",
        );
        return options;
    }
    if (sessionConfigurationMatches(option, selection)) {
        return options;
    }
    return await sessions.configureSession({
        additionalDirectories,
        agent,
        booleanValue: selection.booleanValue,
        configId: selection.configId,
        cwd,
        requestId: `cfg_${randomUUID()}`,
        sessionId,
        signal,
        value: selection.value,
        valueType: selection.valueType,
    });
}

export async function applyCompleteSessionConfiguration(
    sessions: AcpSessionManager,
    audit: AuditStore,
    initialOptions: readonly SessionConfigOption[],
    selections: readonly SessionConfigurationSelection[],
    agent: AcpAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    commandId: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<void> {
    let options = initialOptions;
    const orderedSelections = selections.toSorted((left, right) => {
        const priority =
            sessionConfigurationPriority(left, initialOptions) - sessionConfigurationPriority(right, initialOptions);
        return priority === 0 ? left.configId.localeCompare(right.configId) : priority;
    });
    for (const selection of orderedSelections) {
        options = await applySessionConfigurationSelection(
            sessions,
            audit,
            options,
            selection,
            agent,
            cwd,
            additionalDirectories,
            commandId,
            sessionId,
            signal,
        );
    }
    assertAppliedSessionConfiguration(options, selections);
}

function warnIgnoredSetting(
    audit: AuditStore,
    event: string,
    commandId: string,
    sessionId: string,
    agentId: string,
    selection: SessionConfigurationSelection,
    category: string,
    reason: string,
): void {
    const details: Readonly<Record<string, string>> = {
        agentId,
        category,
        configId: selection.configId,
        reason,
        requestedValue: selection.value,
    };
    audit.record({ commandId, details, event, sessionId });
    process.stderr.write(`Mobius daemon warning ${JSON.stringify({ commandId, event, sessionId, ...details })}\n`);
}
