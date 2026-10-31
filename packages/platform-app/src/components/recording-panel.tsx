import type { MobiusRecordingPolicyMode } from "@moxt-ai/mobius-sdk/platform";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { platformDataTestId } from "../data-testid.ts";
import type { RecordingState } from "../view-models/platform-app-view-model.ts";
import { RecordingPolicyControl } from "./recording-policy-control.tsx";

export interface RecordingPanelProps {
    readonly appRecording: RecordingState;
    readonly busy: string;
    readonly onAppModeChange: (mode: MobiusRecordingPolicyMode) => void;
}

function PanelNote({ children }: { readonly children: ReactNode }) {
    return <p className="mt-1.5 text-sm leading-6 text-[#69766f]">{children}</p>;
}

function Spinner({ label }: { readonly label: string }) {
    return (
        <div
            className="flex min-h-40 items-center justify-center gap-3 text-sm text-[#69766f]"
            role="status"
            aria-live="polite"
        >
            <LoaderCircle className="motion-safe:animate-spin text-[#168247]" size={20} aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

/** One Recording setting governs every Project in the App. */
export function RecordingPanel({ appRecording, busy, onAppModeChange }: RecordingPanelProps) {
    if (appRecording.kind === "loading") {
        return <Spinner label="Loading recording settings…" />;
    }
    if (appRecording.kind === "failed") {
        return (
            <PanelNote>
                Recording settings could not be loaded. Reopen this app to try again, or check that Recording is
                installed on this Platform.
            </PanelNote>
        );
    }

    const policy = appRecording.policy;
    return (
        <div className="mt-6 grid gap-6">
            <section>
                <h3 className="m-0 text-xl font-bold">App recording</h3>
                <PanelNote>
                    Cloud Recording keeps Session history available without the paired machine. It is best effort and
                    never blocks live output. Enable or disable it for all projects in this app. Changes do not erase
                    existing history.
                </PanelNote>
                {!policy.providerAvailable ? (
                    <PanelNote>Recording is not installed on this Platform, so it cannot be enabled here.</PanelNote>
                ) : null}
                <div className="mt-4">
                    <RecordingPolicyControl
                        busy={busy === "app-recording"}
                        effectiveMode={policy.effectiveMode}
                        inheritedFrom={policy.inheritedFrom}
                        label={`Recording for app`}
                        mode={policy.effectiveMode}
                        onModeChange={onAppModeChange}
                        providerAvailable={policy.providerAvailable}
                        testId={platformDataTestId.appRecordingMode}
                    />
                </div>
            </section>
        </div>
    );
}
