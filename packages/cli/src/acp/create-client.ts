import {
    type ClientApp,
    type CompleteElicitationNotification,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    client,
    methods,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface AcpClientHandler {
    readonly onElicitation: (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ) => Promise<CreateElicitationResponse>;
    readonly onElicitationComplete: (notification: CompleteElicitationNotification) => Promise<void>;
    readonly onPermission: (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ) => Promise<RequestPermissionResponse>;
    readonly onUpdate: (notification: SessionNotification) => Promise<void>;
}

export const createAcpClient = (handler: AcpClientHandler): ClientApp =>
    client({ name: "mobius" })
        .onRequest(
            methods.client.session.requestPermission,
            async (context) => await handler.onPermission(context.params, context.signal),
        )
        .onRequest(
            methods.client.elicitation.create,
            async (context) => await handler.onElicitation(context.params, context.signal),
        )
        .onNotification(methods.client.session.update, async (context) => {
            await handler.onUpdate(context.params);
        })
        .onNotification(methods.client.elicitation.complete, async (context) => {
            await handler.onElicitationComplete(context.params);
        });
