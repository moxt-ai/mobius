import {
    type AgentConnection,
    methods,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface PiAcpClient {
    readonly requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    readonly sessionUpdate: (notification: SessionNotification) => Promise<void>;
}

export function createPiAcpClient(
    connection: AgentConnection,
    onSessionUpdate: (notification: SessionNotification) => Promise<void>,
): PiAcpClient {
    return {
        requestPermission: async (request) =>
            await connection.client.request(methods.client.session.requestPermission, request),
        sessionUpdate: onSessionUpdate,
    };
}
