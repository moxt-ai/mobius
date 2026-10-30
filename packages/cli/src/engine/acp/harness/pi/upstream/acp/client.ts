import type {
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PiSessionNotification } from "./session-update.js";

export interface PiAcpClient {
    readonly requestElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    readonly sessionUpdate: (notification: PiSessionNotification) => Promise<void>;
    readonly startUserMessage: () => void;
}
