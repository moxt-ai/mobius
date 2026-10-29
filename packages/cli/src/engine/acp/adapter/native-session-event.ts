import type {
    CompleteElicitationNotification,
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
    type AcpSessionUpdate,
    decodeAcpSessionUpdate,
    type SessionCommand,
    type SessionConfigOption,
} from "@moxt-ai/mobius-sdk/protocol";
import { truncate } from "../../util/value-utils.ts";
import type { BackgroundActivity } from "../agent/in-process-endpoint.ts";
import { normalizeConfigOptions } from "../protocol/session-config-protocol.ts";

export type NativeSessionInfoChange =
    | { readonly kind: "title"; readonly value: string }
    | { readonly kind: "updated-at"; readonly value: string };

export interface NativeSessionInteractions {
    readonly onPermission: (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ) => Promise<RequestPermissionResponse>;
    readonly onElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly onElicitationComplete: (notification: CompleteElicitationNotification) => Promise<void>;
}

export interface NativeSessionSubscriber {
    readonly onSessionEvent: (nativeSessionId: string, event: NativeSessionEvent) => Promise<void>;
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly interactions: NativeSessionInteractions;
}

export type NativeSessionEvent =
    | { readonly kind: "content" | "other"; readonly payload: AcpSessionUpdate }
    | { readonly kind: "commands"; readonly commands: readonly SessionCommand[]; readonly payload: AcpSessionUpdate }
    | {
          readonly kind: "configuration";
          readonly configOptions: readonly SessionConfigOption[];
          readonly payload: AcpSessionUpdate;
      }
    | { readonly kind: "mode"; readonly modeId: string; readonly payload: AcpSessionUpdate }
    | {
          readonly kind: "info";
          readonly changes: readonly NativeSessionInfoChange[];
          readonly payload: AcpSessionUpdate;
      };

/** Value conversion only; the harness owns state and the consumer owns publication. */
export function nativeSessionEvent(update: SessionUpdate, value: unknown = update): NativeSessionEvent {
    const payload = decodeAcpSessionUpdate(JSON.stringify(value));
    switch (update.sessionUpdate) {
        case "available_commands_update":
            return {
                kind: "commands",
                payload,
                commands: update.availableCommands
                    .slice(0, 500)
                    .map((command) => ({
                        name: truncate(command.name, 128),
                        description: truncate(command.description, 500),
                        inputHint: truncate(command.input?.hint ?? "", 255),
                    }))
                    .filter((command) => command.name.length > 0),
            };
        case "config_option_update":
            return {
                kind: "configuration",
                payload,
                configOptions: normalizeConfigOptions(update.configOptions, undefined),
            };
        case "current_mode_update":
            return { kind: "mode", payload, modeId: update.currentModeId };
        case "session_info_update": {
            const changes: NativeSessionInfoChange[] = [];
            if (Object.hasOwn(update, "title")) {
                changes.push({ kind: "title", value: truncate(update.title ?? "", 500) });
            }
            if (Object.hasOwn(update, "updatedAt")) {
                changes.push({ kind: "updated-at", value: truncate(update.updatedAt ?? "", 128) });
            }
            return {
                kind: "info",
                payload,
                changes,
            };
        }
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
        case "tool_call":
        case "tool_call_update":
        case "plan":
        case "plan_update":
        case "plan_removed":
            return { kind: "content", payload };
        default:
            return { kind: "other", payload };
    }
}
