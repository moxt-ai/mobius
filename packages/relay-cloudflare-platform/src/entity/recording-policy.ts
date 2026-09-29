export type RecordingPolicyMode = "inherit" | "enabled" | "disabled";
export type EffectiveRecordingMode = Exclude<RecordingPolicyMode, "inherit">;
export type RecordingPolicySource = "system" | "app" | "project";

export interface ResolvedRecordingPolicy {
    readonly effectiveMode: EffectiveRecordingMode;
    readonly inheritedFrom: RecordingPolicySource;
    readonly mode: RecordingPolicyMode;
}

export interface ProjectRecordingPolicyTarget {
    readonly appId: string;
    readonly projectId: string;
}
