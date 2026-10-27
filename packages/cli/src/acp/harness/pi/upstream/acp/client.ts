import {
    type AgentConnection,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PiSessionNotification } from "./session-update.js";

export interface PiAcpClient {
    readonly requestElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    readonly sessionUpdate: (notification: PiSessionNotification) => Promise<void>;
}

export function createPiAcpClient(
    connection: AgentConnection,
    onSessionUpdate: (notification: PiSessionNotification) => Promise<void>,
): PiAcpClient {
    return {
        requestElicitation: async (request, signal) =>
            await connection.client.request(methods.client.elicitation.create, request, { cancellationSignal: signal }),
        requestPermission: async (request) =>
            await connection.client.request(methods.client.session.requestPermission, request),
        sessionUpdate: onSessionUpdate,
    };
}
