import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/platform";

const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ORGANIZATION_ID_PATTERN = /^org_[a-zA-Z0-9]+$/;
const INVITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OrganizationInvite = {
    readonly id: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly role: "org:member";
};
export type CreatedOrganizationInvite = OrganizationInvite & { readonly token: string };
export type OrganizationInvitePreview = {
    readonly organizationId: string;
    readonly organizationName: string;
    readonly member: boolean;
};

type GetToken = () => Promise<string>;

function inviteUrl(endpoint: string, path: string): URL {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("The Platform endpoint is invalid");
    }
    if (url.pathname === "/") {
        url.pathname = `${MOBIUS_API_PREFIX}/`;
    } else if (!url.pathname.endsWith("/")) {
        url.pathname = `${url.pathname}/`;
    }
    return new URL(path, url);
}

async function inviteError(response: Response): Promise<Error> {
    try {
        const value: unknown = await response.json();
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const error = (value as Record<string, unknown>)["error"];
            if (typeof error === "object" && error !== null && !Array.isArray(error)) {
                const message = (error as Record<string, unknown>)["message"];
                if (typeof message === "string" && message.length > 0) {
                    return new Error(message);
                }
            }
        }
    } catch {
        // Fall through to the generic message below.
    }
    return new Error("The Platform invitation request failed");
}

async function inviteRequest(
    endpoint: string,
    getToken: GetToken,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: Record<string, string> | null,
    signal: AbortSignal,
): Promise<unknown> {
    const token = await getToken();
    const response = await fetch(inviteUrl(endpoint, path), {
        body: body === null ? null : JSON.stringify(body),
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === null ? {} : { "content-type": "application/json" }),
            "x-mobius-oidc-provider": "clerk",
        },
        method,
        signal,
    });
    if (!response.ok) {
        throw await inviteError(response);
    }
    return await response.json();
}

function inviteRecord(value: unknown): Record<string, unknown> {
    const recordValue =
        value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (recordValue === null) {
        throw new Error("The Platform returned an invalid invitation");
    }
    return recordValue;
}

function inviteInteger(value: Record<string, unknown>, field: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new Error("The Platform returned an invalid invitation");
    }
    return candidate;
}

function inviteString(value: Record<string, unknown>, field: string): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length === 0) {
        throw new Error("The Platform returned an invalid invitation");
    }
    return candidate;
}

function inviteLink(value: unknown): OrganizationInvite {
    const recordValue = inviteRecord(value);
    const id = inviteString(recordValue, "id");
    if (!INVITE_ID_PATTERN.test(id) || inviteString(recordValue, "role") !== "org:member") {
        throw new Error("The Platform returned an invalid invitation");
    }
    return Object.freeze({
        id,
        createdAt: inviteInteger(recordValue, "createdAt"),
        expiresAt: inviteInteger(recordValue, "expiresAt"),
        role: "org:member",
    });
}

function organizationId(value: string): string {
    if (!ORGANIZATION_ID_PATTERN.test(value)) {
        throw new Error("The Platform organization is invalid");
    }
    return value;
}

function inviteToken(value: string): string {
    if (!INVITE_TOKEN_PATTERN.test(value)) {
        throw new Error("The invitation link is invalid");
    }
    return value;
}

export async function createOrganizationInvite(
    endpoint: string,
    getToken: GetToken,
    organization: string,
    signal: AbortSignal,
): Promise<CreatedOrganizationInvite> {
    const value = inviteRecord(
        await inviteRequest(
            endpoint,
            getToken,
            "POST",
            `dashboard/v1/platform/tenants/${encodeURIComponent(organizationId(organization))}/invite-links`,
            {},
            signal,
        ),
    );
    const token = inviteString(value, "token");
    if (!INVITE_TOKEN_PATTERN.test(token)) {
        throw new Error("The Platform returned an invalid invitation");
    }
    return Object.freeze({ ...inviteLink(value), token });
}

export async function listOrganizationInvites(
    endpoint: string,
    getToken: GetToken,
    organization: string,
    signal: AbortSignal,
): Promise<readonly OrganizationInvite[]> {
    const value = await inviteRequest(
        endpoint,
        getToken,
        "GET",
        `dashboard/v1/platform/tenants/${encodeURIComponent(organizationId(organization))}/invite-links`,
        null,
        signal,
    );
    if (!Array.isArray(value)) {
        throw new Error("The Platform returned an invalid invitation list");
    }
    return Object.freeze(value.map((link) => inviteLink(link)));
}

export async function revokeOrganizationInvite(
    endpoint: string,
    getToken: GetToken,
    organization: string,
    id: string,
    signal: AbortSignal,
): Promise<void> {
    if (!INVITE_ID_PATTERN.test(id)) {
        throw new Error("The invitation is invalid");
    }
    await inviteRequest(
        endpoint,
        getToken,
        "DELETE",
        `dashboard/v1/platform/tenants/${encodeURIComponent(organizationId(organization))}/invite-links/${encodeURIComponent(id)}`,
        null,
        signal,
    );
}

async function organizationInviteAction(
    action: "preview" | "accept",
    endpoint: string,
    getToken: GetToken,
    token: string,
    signal: AbortSignal,
): Promise<OrganizationInvitePreview> {
    const value = inviteRecord(
        await inviteRequest(
            endpoint,
            getToken,
            "POST",
            `dashboard/v1/platform/invite-links/${action}`,
            {
                token: inviteToken(token),
            },
            signal,
        ),
    );
    const member = value["member"];
    if (typeof member !== "boolean" || !ORGANIZATION_ID_PATTERN.test(inviteString(value, "organizationId"))) {
        throw new Error("The Platform returned an invalid invitation");
    }
    return Object.freeze({
        organizationId: inviteString(value, "organizationId"),
        organizationName: inviteString(value, "organizationName"),
        member,
    });
}

export async function previewOrganizationInvite(
    endpoint: string,
    getToken: GetToken,
    token: string,
    signal: AbortSignal,
): Promise<OrganizationInvitePreview> {
    return await organizationInviteAction("preview", endpoint, getToken, token, signal);
}

export async function acceptOrganizationInvite(
    endpoint: string,
    getToken: GetToken,
    token: string,
    signal: AbortSignal,
): Promise<OrganizationInvitePreview> {
    return await organizationInviteAction("accept", endpoint, getToken, token, signal);
}
