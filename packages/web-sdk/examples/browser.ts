import type { MobiusCredentialProvider } from "@moxt-ai/mobius-sdk";

import { MobiusExampleOptions, runMobiusExample } from "./workflow.ts";

export class MobiusBrowserExampleOptions {
    readonly agentId: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly endpoint: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceRef: string;
    readonly write: (text: string) => void;

    constructor(
        endpoint: string,
        projectId: string,
        runtimeId: string,
        agentId: string,
        workspaceRef: string,
        credentialProvider: MobiusCredentialProvider,
        write: (text: string) => void,
    ) {
        this.agentId = agentId;
        this.credentialProvider = credentialProvider;
        this.endpoint = endpoint;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceRef = workspaceRef;
        this.write = write;
    }
}

export async function runMobiusBrowserExample(
    options: MobiusBrowserExampleOptions,
    signal: AbortSignal,
): Promise<void> {
    await runMobiusExample(
        new MobiusExampleOptions(
            options.endpoint,
            options.projectId,
            options.runtimeId,
            options.agentId,
            options.workspaceRef,
            options.credentialProvider,
            options.write,
        ),
        signal,
    );
}
