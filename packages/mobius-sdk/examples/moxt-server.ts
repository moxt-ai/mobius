import { MobiusOidcCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";

export interface MoxtAppCredentialVault {
    readonly put: (credential: string, signal: AbortSignal) => Promise<void>;
}

export class MoxtPlatformProvisioningOptions {
    readonly appDisplayName: string;
    readonly endpoint: string;
    readonly oidcProviderId: string;
    readonly oidcToken: string;
    readonly projectClientReference: string;
    readonly projectDisplayName: string;
    readonly projectIdempotencyKey: string;
    readonly tenantId: string;

    constructor(
        endpoint: string,
        oidcProviderId: string,
        oidcToken: string,
        tenantId: string,
        appDisplayName: string,
        projectDisplayName: string,
        projectClientReference: string,
        projectIdempotencyKey: string,
    ) {
        this.endpoint = endpoint;
        this.oidcProviderId = oidcProviderId;
        this.oidcToken = oidcToken;
        this.tenantId = tenantId;
        this.appDisplayName = appDisplayName;
        this.projectDisplayName = projectDisplayName;
        this.projectClientReference = projectClientReference;
        this.projectIdempotencyKey = projectIdempotencyKey;
    }
}

export class MoxtProvisionedPlatformProject {
    readonly appId: string;
    readonly projectId: string;

    constructor(appId: string, projectId: string) {
        this.appId = appId;
        this.projectId = projectId;
    }
}

/**
 * Run once in a trusted Moxt provisioning process. The App's single default
 * AppCredential is returned by Mobius once and written directly to the vault.
 */
export async function provisionMoxtPlatformProject(
    options: MoxtPlatformProvisioningOptions,
    vault: MoxtAppCredentialVault,
    signal: AbortSignal,
): Promise<MoxtProvisionedPlatformProject> {
    const platform = new MobiusPlatformDeveloperClient({
        authenticationProviderId: options.oidcProviderId,
        credentialProvider: new MobiusOidcCredentialProvider(options.oidcToken),
        endpoint: options.endpoint,
    });
    const app = await platform.createApp(options.tenantId, options.appDisplayName, signal, true);
    await vault.put(app.defaultCredential.credential, signal);
    const project = await platform.createProject(
        app.appId,
        {
            clientReference: options.projectClientReference,
            displayName: options.projectDisplayName,
            idempotencyKey: options.projectIdempotencyKey,
            locationHint: "apac",
        },
        signal,
    );
    return new MoxtProvisionedPlatformProject(app.appId, project.projectId);
}

/**
 * Construct all Moxt Server responsibilities from one AppCredential. Split it
 * only when the responsibilities run in independent deployment or secret
 * boundaries. No Mobius credential from this object belongs in a browser.
 */
export class MoxtPlatformServerClients {
    readonly project: MobiusClient;

    constructor(endpoint: string, projectId: string, appCredential: string) {
        this.project = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(appCredential),
            endpoint,
            projectId,
        });
    }

    readonly close = (): void => {
        this.project.close();
    };
}
