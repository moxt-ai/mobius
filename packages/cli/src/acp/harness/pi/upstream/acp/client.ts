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
    readonly createElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    readonly sessionUpdate: (notification: SessionNotification) => Promise<void>;
}

export function createPiAcpClient(connection: AgentConnection): PiAcpClient {
    return {
        createElicitation: async (request, signal) =>
            await connection.client.request(methods.client.elicitation.create, request, { cancellationSignal: signal }),
        requestPermission: async (request) =>
            await connection.client.request(methods.client.session.requestPermission, request),
        sessionUpdate: async (notification) => {
            await connection.client.notify(methods.client.session.update, notification);
        },
    };
}
