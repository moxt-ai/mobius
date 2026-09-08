import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";

export interface SessionConfigSummary {
    readonly accessibleLabel: string;
    readonly compactLabel: string;
}

export interface SessionConfigSection {
    readonly id: "model" | "execution" | "other";
    readonly label: string;
    readonly options: readonly SessionConfigOption[];
}

function currentOptionLabel(option: SessionConfigOption): string {
    if (option.type === "boolean") {
        return option.booleanValue ? "On" : "Off";
    }
    return option.values.find((value) => value.value === option.currentValue)?.name ?? option.currentValue;
}

function firstCategory(options: readonly SessionConfigOption[], category: string): SessionConfigOption | undefined {
    return options.find((option) => option.category === category);
}

function isModelConfigurationOption(option: SessionConfigOption): boolean {
    return option.category === "model" || option.category === "thought_level" || option.category === "model_config";
}

export function summarizeSessionConfig(options: readonly SessionConfigOption[]): SessionConfigSummary {
    if (options.length === 0) {
        return {
            accessibleLabel: "Run settings: agent defaults",
            compactLabel: "Agent defaults",
        };
    }

    const primaryOptions = [firstCategory(options, "model"), firstCategory(options, "thought_level")].filter(
        (option) => option !== undefined,
    );
    const visibleOptions = primaryOptions.length > 0 ? primaryOptions.slice(0, 2) : options.slice(0, 1);
    const labels = visibleOptions.map(currentOptionLabel);
    const remaining = options.length - visibleOptions.length;
    const accessibleParts = [...labels];
    if (remaining > 0) {
        accessibleParts.push(`and ${remaining.toString()} more ${remaining === 1 ? "setting" : "settings"}`);
    }
    return {
        accessibleLabel: `Run settings: ${accessibleParts.join(", ")}`,
        compactLabel: labels.join(" · "),
    };
}

function sectionId(option: SessionConfigOption): SessionConfigSection["id"] {
    if (isModelConfigurationOption(option)) {
        return "model";
    }
    if (option.category === "mode" || option.category === "collaboration_mode") {
        return "execution";
    }
    return "other";
}

export function groupSessionConfigOptions(options: readonly SessionConfigOption[]): readonly SessionConfigSection[] {
    const definitions: readonly Omit<SessionConfigSection, "options">[] = [
        { id: "model", label: "Model" },
        { id: "execution", label: "Execution" },
        { id: "other", label: "Other" },
    ];
    return definitions.flatMap((definition) => {
        const sectionOptions = options.filter((option) => sectionId(option) === definition.id);
        return sectionOptions.length === 0 ? [] : [{ ...definition, options: sectionOptions }];
    });
}
