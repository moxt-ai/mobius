import type { MobiusRecordingPolicyMode } from "@moxt-ai/mobius-sdk/platform";
import { FolderTree, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { platformDataTestId } from "../data-testid.ts";
import type { ProjectRecording, ProjectsState, RecordingState } from "../view-models/platform-app-view-model.ts";
import { RecordingPolicyControl } from "./recording-policy-control.tsx";

export interface RecordingPanelProps {
    readonly appRecording: RecordingState;
    readonly busy: string;
    readonly onAppModeChange: (mode: MobiusRecordingPolicyMode) => void;
    readonly onProjectModeChange: (projectId: string, mode: MobiusRecordingPolicyMode) => void;
    readonly projects: ProjectsState;
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

/** Shows App-level Recording policy and the Projects that can override it. */
export function RecordingPanel({
    appRecording,
    busy,
    onAppModeChange,
    onProjectModeChange,
    projects,
}: RecordingPanelProps) {
    if (appRecording.kind === "loading") {
        return <Spinner label="Loading recording settings…" />;
    }
    if (appRecording.kind === "failed" || projects.kind === "failed") {
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
                    never blocks live output. Inherit keeps the platform default, which is off.
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
                        mode={policy.mode}
                        onModeChange={onAppModeChange}
                        providerAvailable={policy.providerAvailable}
                        testId={platformDataTestId.appRecordingMode}
                    />
                </div>
            </section>
            <section>
                <h3 className="m-0 text-xl font-bold">Project recording</h3>
                <PanelNote>
                    A Project can override the App setting. Overrides apply immediately to newly recorded events and do
                    not erase existing history.
                </PanelNote>
                {projects.kind === "loading" ? (
                    <Spinner label="Loading projects…" />
                ) : projects.items.length === 0 ? (
                    <div className="mt-4 grid justify-items-center rounded-lg border border-dashed border-[#dde3df] px-5 py-10 text-center text-[#819087]">
                        <FolderTree size={26} aria-hidden="true" />
                        <p className="mt-2 text-sm">This app has no projects yet.</p>
                    </div>
                ) : (
                    <div className="mt-4 overflow-x-auto rounded-lg border border-[#dde3df]">
                        <div className="grid min-h-[38px] min-w-[640px] grid-cols-[minmax(180px,1.6fr)_minmax(180px,1fr)_auto] items-center gap-3 bg-[#f8faf8] px-3.5 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-[#849087]">
                            <span>Project</span>
                            <span>Project ID</span>
                            <span>Recording</span>
                        </div>
                        {projects.items.map(({ policy: projectPolicy, project }: ProjectRecording) => (
                            <div
                                className="grid min-h-14 min-w-[640px] grid-cols-[minmax(180px,1.6fr)_minmax(180px,1fr)_auto] items-center gap-3 border-t border-[#e8ece9] px-3.5 py-3 text-xs text-[#5f6c65] first:border-t-0"
                                key={project.projectId}
                            >
                                <span className="truncate font-bold text-[#3b4941]">{project.displayName}</span>
                                <code className="truncate text-[11px] text-[#69776f]">{project.projectId}</code>
                                <RecordingPolicyControl
                                    busy={busy === `project-recording-${project.projectId}`}
                                    effectiveMode={projectPolicy.effectiveMode}
                                    inheritedFrom={projectPolicy.inheritedFrom}
                                    label={`Recording for project ${project.displayName}`}
                                    mode={projectPolicy.mode}
                                    onModeChange={(mode) => onProjectModeChange(project.projectId, mode)}
                                    providerAvailable={projectPolicy.providerAvailable}
                                    testId={`${platformDataTestId.projectRecordingMode}-${project.projectId}`}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
