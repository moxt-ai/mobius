import {
    type AgentConnection,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface PiAcpClient {
    readonly requestElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    readonly sessionUpdate: (notification: SessionNotification) => Promise<void>;
}

export function createPiAcpClient(
    connection: AgentConnection,
    onSessionUpdate: (notification: SessionNotification) => Promise<void>,
): PiAcpClient {
    return {
        requestElicitation: async (request, signal) =>
            await connection.client.request(methods.client.elicitation.create, request, { cancellationSignal: signal }),
        requestPermission: async (request) =>
            await connection.client.request(methods.client.session.requestPermission, request),
        sessionUpdate: onSessionUpdate,
    };
}
