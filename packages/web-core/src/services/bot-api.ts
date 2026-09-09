import {
    MobiusArtifactUploadRequest,
    MobiusBotOwnerClient,
    MobiusClient,
    type MobiusMessagePage,
    MobiusPageRequest,
    type MobiusSession,
    type PromptImage,
    type PromptResource,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

import type { ChannelConnection } from "@/domain/channel";

const BOT_MESSAGE_PAGE_SIZE = 100;

function client(connection: ChannelConnection): MobiusClient {
    return new MobiusClient({
        credentialProvider: credentialProvider(connection),
        endpoint: window.location.origin,
        projectId: connection.projectId,
    });
}

function decodeImageBytes(data: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(data);
    } catch (cause) {
        throw new Error("The image attachment is not valid base64", { cause });
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digest(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    signal.throwIfAborted();
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function upload(
    api: MobiusClient,
    sessionId: string,
    name: string,
    mediaType: string,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<string> {
    if (bytes.byteLength === 0) {
        throw new Error("An empty attachment cannot be uploaded");
    }
    const authorization = await api.artifacts.createUpload(
        sessionId,
        new MobiusArtifactUploadRequest(name, mediaType, bytes.byteLength, await digest(bytes, signal)),
        signal,
    );
    await api.artifacts.uploadContent(sessionId, authorization, bytes, signal);
    return authorization.artifactId;
}

function credentialProvider(connection: ChannelConnection): StaticMobiusCredentialProvider {
    return new StaticMobiusCredentialProvider(connection.hostToken);
}

export function createBotOwnerClient(connection: ChannelConnection): MobiusBotOwnerClient {
    return new MobiusBotOwnerClient({
        credentialProvider: credentialProvider(connection),
        endpoint: window.location.origin,
        projectId: connection.projectId,
    });
}

export async function readBotConversationMessages(
    connection: ChannelConnection,
    sessionId: string,
    cursor: string,
    signal: AbortSignal,
): Promise<MobiusMessagePage> {
    const api = client(connection);
    try {
        return await api.sessions.readMessages(sessionId, new MobiusPageRequest(BOT_MESSAGE_PAGE_SIZE, cursor), signal);
    } finally {
        api.close();
    }
}

export async function readBotConversationSession(
    connection: ChannelConnection,
    sessionId: string,
    signal: AbortSignal,
): Promise<MobiusSession> {
    const api = client(connection);
    try {
        return await api.sessions.read(sessionId, signal);
    } finally {
        api.close();
    }
}

export async function updateBotConversationWorkspace(
    connection: ChannelConnection,
    session: MobiusSession,
    workspaceRef: string,
    signal: AbortSignal,
): Promise<MobiusSession> {
    const api = client(connection);
    try {
        return await api.sessions.configure(
            session.sessionId,
            {
                agentRef: session.defaultBinding.agentRef,
                bindingId: session.defaultBinding.bindingId,
                configRevision: session.defaultBinding.configRevision + 1,
                runtimeId: session.defaultBinding.runtimeId,
                workspaceRef,
            },
            signal,
        );
    } finally {
        api.close();
    }
}

export async function uploadBotPromptAttachments(
    connection: ChannelConnection,
    sessionId: string,
    images: readonly PromptImage[],
    resources: readonly PromptResource[],
    signal: AbortSignal,
): Promise<readonly string[]> {
    const api = client(connection);
    const artifactIds: string[] = [];
    try {
        for (const image of images) {
            artifactIds.push(
                await upload(api, sessionId, image.name, image.mimeType, decodeImageBytes(image.data), signal),
            );
        }
        for (const resource of resources) {
            if (resource.type !== "embedded") {
                throw new Error("Only embedded files can be attached to an owner Bot message");
            }
            artifactIds.push(
                await upload(
                    api,
                    sessionId,
                    resource.name,
                    resource.mimeType,
                    new TextEncoder().encode(resource.text),
                    signal,
                ),
            );
        }
        return Object.freeze(artifactIds);
    } finally {
        api.close();
    }
}
