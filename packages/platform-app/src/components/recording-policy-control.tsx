import type { MobiusRecordingPolicyMode } from "@moxt-ai/mobius-sdk/platform";
import { Check, LoaderCircle } from "lucide-react";
import { useId } from "react";

const MODES: readonly { readonly label: string; readonly mode: MobiusRecordingPolicyMode }[] = [
    { label: "Inherit", mode: "inherit" },
    { label: "Enabled", mode: "enabled" },
    { label: "Disabled", mode: "disabled" },
];

export interface RecordingPolicyControlProps {
    readonly busy: boolean;
    readonly effectiveMode: "enabled" | "disabled";
    readonly inheritedFrom: "system" | "app" | "project";
    readonly label: string;
    readonly mode: MobiusRecordingPolicyMode;
    readonly onModeChange: (mode: MobiusRecordingPolicyMode) => void;
    readonly providerAvailable: boolean;
    readonly testId: string;
}

/** Segmented Recording mode picker shared by the App and Project configuration surfaces. */
export function RecordingPolicyControl({
    busy,
    effectiveMode,
    inheritedFrom,
    label,
    mode,
    onModeChange,
    providerAvailable,
    testId,
}: RecordingPolicyControlProps) {
    const groupName = useId();
    return (
        <div className="flex flex-wrap items-center gap-3">
            <fieldset
                className="m-0 flex min-w-0 gap-0 rounded-lg border border-[#ccd5cf] bg-[#f8faf8] p-0.5"
                data-testid={testId}
            >
                <legend className="sr-only">{label}</legend>
                {MODES.map(({ label: modeLabel, mode: candidate }) => {
                    const selected = candidate === mode;
                    const disabledByProvider = candidate === "enabled" && !providerAvailable;
                    return (
                        <label
                            key={candidate}
                            className={
                                selected
                                    ? "inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-md bg-white px-3 text-xs font-bold text-[#168247] shadow-sm has-disabled:cursor-not-allowed has-disabled:opacity-50"
                                    : "inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs font-bold text-[#69766f] hover:text-[#168247] has-disabled:cursor-not-allowed has-disabled:opacity-50"
                            }
                            title={disabledByProvider ? "Recording is not installed on this Platform" : undefined}
                        >
                            <input
                                type="radio"
                                name={groupName}
                                value={candidate}
                                checked={selected}
                                disabled={busy || disabledByProvider}
                                onChange={() => onModeChange(candidate)}
                                className="sr-only"
                            />
                            {busy && selected ? (
                                <LoaderCircle className="motion-safe:animate-spin" size={13} aria-hidden="true" />
                            ) : null}
                            {modeLabel}
                        </label>
                    );
                })}
            </fieldset>
            <span
                className={
                    effectiveMode === "enabled"
                        ? "inline-flex items-center gap-1.5 rounded-full bg-[#e5f3e9] px-2.5 py-1 text-[10px] font-bold tracking-wide text-[#168247] uppercase"
                        : "inline-flex items-center gap-1.5 rounded-full bg-[#eef1ef] px-2.5 py-1 text-[10px] font-bold tracking-wide text-[#7a8780] uppercase"
                }
            >
                <Check size={12} aria-hidden="true" />
                {effectiveMode === "enabled" ? "Recording on" : "Recording off"}
                <span className="font-medium tracking-normal normal-case">
                    ({inheritedFrom === "system" ? "platform default" : `from ${inheritedFrom}`})
                </span>
            </span>
        </div>
    );
}
