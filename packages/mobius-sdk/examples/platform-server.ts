import {
    MobiusAppCredentialProvider,
    MobiusOidcCredentialProvider,
    MobiusPlatformAppClient,
    MobiusPlatformDeveloperClient,
} from "@moxt-ai/mobius-sdk/platform";

const endpoint = "https://relay.example.com";
const signal = AbortSignal.timeout(20_000);

const developers = new MobiusPlatformDeveloperClient({
    authenticationProviderId: "clerk",
    credentialProvider: new MobiusOidcCredentialProvider(process.env["MOBIUS_OIDC_TOKEN"] ?? ""),
    endpoint,
});

const tenant = (await developers.listTenants(signal))[0];
if (tenant === undefined) {
    throw new Error("Select a Clerk organization before running this example");
}
const app = await developers.createApp(tenant.tenantId, "Example app", signal);
const project = await developers.createProject(
    app.appId,
    {
        clientReference: "customer-42",
        displayName: "Customer 42",
        idempotencyKey: "provision-customer-42",
        locationHint: "apac",
    },
    signal,
);

const application = new MobiusPlatformAppClient({
    credentialProvider: new MobiusAppCredentialProvider(app.defaultCredential.credential),
    endpoint,
});

void application;
void project;

export async function issueBrowserConversationAccess(
    conversationId: string,
    actorRef: string,
    requestSignal: AbortSignal,
) {
    return await application.issueConversationAccessCredential(
        conversationId,
        {
            actorRef,
            expiresInSeconds: 30 * 60,
            permissions: [
                "artifact:read",
                "artifact:write",
                "conversation:event:read",
                "conversation:message:create",
                "conversation:read",
                "conversation:turn:cancel",
                "conversation:turn:create",
                "interaction:respond",
            ],
        },
        requestSignal,
    );
}
