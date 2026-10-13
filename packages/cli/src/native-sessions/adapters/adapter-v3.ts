import type {
    PromptImage,
    PromptResource,
    SessionHistoryPageRequestV3,
    SessionHistoryPageV3,
    SessionLiveEventItemV3,
    SessionPermissionResponseV3,
    SessionSettingChangeV3,
    SessionSettingsV3,
    SessionUserInputResponseV3,
} from "@moxt-ai/mobius-protocol";

export interface NativeSessionContextV3 {
    readonly additionalDirectories: readonly string[];
    readonly cwd: string;
    readonly nativeSessionId: string;
    readonly sessionId: string;
}

export class NativeSessionConnectionErrorV3 extends Error {
    readonly code: "native_process_exited" | "native_protocol_error" | "native_stream_closed";

    constructor(code: NativeSessionConnectionErrorV3["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "NativeSessionConnectionErrorV3";
    }
}

export class NativeSessionOperationErrorV3 extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "NativeSessionOperationErrorV3";
    }
}

export type NativeSessionTerminationV3 =
    | { readonly kind: "closed" }
    | { readonly error: NativeSessionConnectionErrorV3; readonly kind: "failed" };

export interface NativeSessionPromptV3 {
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
}

export interface NativeSessionPromptResultV3 {
    readonly stopReason: "cancelled" | "end_turn";
}

export type PublishSessionLiveItemV3 = (item: SessionLiveEventItemV3) => Promise<void>;

export interface ConnectedNativeSessionV3 {
    readonly nativeSessionId: string;
    readonly applySetting: (change: SessionSettingChangeV3, signal: AbortSignal) => Promise<SessionSettingsV3>;
    readonly cancelPrompt: (signal: AbortSignal) => Promise<void>;
    readonly close: (signal: AbortSignal) => Promise<void>;
    readonly pageMessages: (request: SessionHistoryPageRequestV3, signal: AbortSignal) => Promise<SessionHistoryPageV3>;
    readonly readSettings: (signal: AbortSignal) => Promise<SessionSettingsV3>;
    readonly runPrompt: (prompt: NativeSessionPromptV3, signal: AbortSignal) => Promise<NativeSessionPromptResultV3>;
    readonly respondPermission: (response: SessionPermissionResponseV3, signal: AbortSignal) => Promise<void>;
    readonly respondUserInput: (response: SessionUserInputResponseV3, signal: AbortSignal) => Promise<void>;
    readonly waitForTermination: (signal: AbortSignal) => Promise<NativeSessionTerminationV3>;
}

export interface NativeSessionAdapterV3 {
    readonly connect: (
        session: NativeSessionContextV3,
        publish: PublishSessionLiveItemV3,
        signal: AbortSignal,
    ) => Promise<ConnectedNativeSessionV3>;
    readonly previewMessages: (
        session: NativeSessionContextV3,
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ) => Promise<SessionHistoryPageV3>;
}

export interface NativeSessionPreviewAdapterV3 {
    readonly previewMessages: (
        session: NativeSessionContextV3,
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ) => Promise<SessionHistoryPageV3>;
}
