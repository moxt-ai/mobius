import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { isIdentifier, mobiusApiUrl } from "@moxt-ai/mobius-sdk/protocol";
import { fetch, type Response } from "undici";
import type { CatalogAgent } from "../agent/catalog.ts";
import { discoverLocalAgentInventory, type LocalAgentInventory } from "../agent/discovery/discover-local-agents.ts";
import { RuntimeAgentDependencies } from "../agent/runtime-agents.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { environmentProxyDispatcher } from "../util/network/environment-proxy.ts";
import { isRecord } from "../util/value-utils.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import {
    createRuntimeConfig,
    OpaqueRuntimeReconnectTarget,
    type RuntimeConfig,
    RuntimeLocalContext,
} from "./config.ts";
import type { VerifiedRuntimeConnection } from "./connection/runtime-connection.ts";
import type { RuntimeInstallationStore } from "./connection/runtime-installation-store.ts";

const PAIRING_TIMEOUT_MILLISECONDS = 20_000;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const CLAIM_RESPONSE_KEYS: readonly string[] = ["appId", "channelId", "daemonToken", "runtimeId"];
const REDEEM_RESPONSE_KEYS: readonly string[] = ["appId", "channelId", "runtimeCredential", "runtimeId"];

interface PairCommandOptions {
    readonly code: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly workspace: string;
}

interface ClaimPairingResponse {
    readonly appId: string;
    readonly channelId: string;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export interface MobiusRuntimePairingOptions {
    readonly defaultWorkspace: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly relayOrigin: string;
}

export class PairingClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingClientError";
    }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

export function parseRelayOrigin(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch (error) {
        throw new PairingClientError("invalid_relay_url", "The relay URL is invalid", { cause: error });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new PairingClientError("invalid_relay_url", "The relay URL must use http or https");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new PairingClientError("invalid_relay_url", "The relay URL cannot contain credentials");
    }
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new PairingClientError("invalid_relay_url", "A remote relay must use https");
    }
    url.hash = "";
    url.pathname = "/";
    url.search = "";
    return url;
}

export function parsePairingCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) {
        throw new PairingClientError(
            "invalid_pairing_code",
            "The pairing code must match the code shown in the browser",
        );
    }
    return code;
}

export function validatePairingId(value: string): string {
    if (!isIdentifier(value)) {
        throw new PairingClientError("invalid_pairing_id", "The Runtime pairing ID is invalid");
    }
    return value;
}

async function resolveDefaultWorkspace(path: string): Promise<string> {
    const requestedWorkspace = resolve(path);
    let defaultWorkspace: string | null;
    try {
        defaultWorkspace = await ensureCanonicalDirectory(requestedWorkspace);
    } catch (error) {
        throw new PairingClientError("invalid_workspace", "The default workspace cannot be resolved", { cause: error });
    }
    if (defaultWorkspace === null) {
        throw new PairingClientError("invalid_workspace", "The default workspace is not a directory");
    }
    return defaultWorkspace;
}

async function readJsonResponse(response: Response): Promise<unknown> {
    if (response.headers.get("cf-mitigated") === "challenge") {
        throw new PairingClientError(
            "relay_challenge",
            "Cloudflare is protecting this temporary preview. Claim the deployment or use an authenticated deployment, then pair again",
        );
    }
    const encoded = await response.text();
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid response", {
            cause: error,
        });
    }
}

function readRelayError(value: unknown): PairingClientError {
    if (isRecord(value)) {
        const error = value["error"];
        if (isRecord(error)) {
            const code = error["code"];
            const message = error["message"];
            if (typeof code === "string" && typeof message === "string") {
                return new PairingClientError(code, message);
            }
        }
    }
    return new PairingClientError("pairing_failed", "The relay could not pair this machine");
}

function decodePairingResponse(
    value: unknown,
    credentialField: string,
    expectedKeys: readonly string[],
): ClaimPairingResponse {
    if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    const appId = value["appId"];
    const channelId = value["channelId"];
    const runtimeCredential = value[credentialField];
    const runtimeId = value["runtimeId"];
    if (
        typeof appId !== "string" ||
        !isIdentifier(appId) ||
        typeof channelId !== "string" ||
        !isIdentifier(channelId) ||
        typeof runtimeCredential !== "string" ||
        !TOKEN_PATTERN.test(runtimeCredential) ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    return { appId, channelId, runtimeCredential, runtimeId };
}

async function claimPairing(
    options: PairCommandOptions,
    defaultWorkspace: string,
    localAgents: readonly CatalogAgent[],
    signal: AbortSignal,
): Promise<ClaimPairingResponse> {
    const agents = localAgents.map((agent) => ({
        agentPath: agent.agentIdentity.requestedPath,
        agentVersion: agent.agentVersion,
        agentSettingsDiscovery: true,
        capabilities: agent.capabilities,
        id: agent.id,
        label: agent.label,
        sessionTurnConfiguration: true,
    }));
    const endpoint =
        options.pairingId.length > 0
            ? mobiusApiUrl(options.relayOrigin, `/v1/runtime-pairings/${encodeURIComponent(options.pairingId)}/redeem`)
            : mobiusApiUrl(options.relayOrigin, "/pairings/claim");
    let response: Response;
    try {
        response = await fetch(endpoint, {
            body: JSON.stringify({
                agents,
                machineName: hostname(),
                pairingCode: options.code,
                workspaceName: basename(defaultWorkspace) || "Local workspace",
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS)]),
        });
    } catch (error) {
        signal.throwIfAborted();
        throw new PairingClientError("relay_unavailable", "The pairing relay could not be reached", { cause: error });
    }

    const value = await readJsonResponse(response);
    if (!response.ok) {
        throw readRelayError(value);
    }
    return options.pairingId.length > 0
        ? decodePairingResponse(value, "runtimeCredential", REDEEM_RESPONSE_KEYS)
        : decodePairingResponse(value, "daemonToken", CLAIM_RESPONSE_KEYS);
}

function buildSavedRuntimeConfig(
    connection: VerifiedRuntimeConnection,
    defaultWorkspace: string,
    inventory: LocalAgentInventory,
    localContext: RuntimeLocalContext,
): RuntimeConfig {
    const relayUrl = mobiusApiUrl(connection.relayOrigin, "/v1/runtimes/connect");
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", connection.runtimeCredential);

    const config: RuntimeConfig = createRuntimeConfig(
        {
            defaultWorkspace,
            channelId: connection.channelId,
            relayUrl,
        },
        new RuntimeAgentDependencies(inventory.readyAgents()),
        localContext,
        new OpaqueRuntimeReconnectTarget(connection.connectionId),
        createCatalogAgentResolver(
            (refreshSignal) =>
                discoverLocalAgentInventory({
                    defaultWorkspace,
                    dataDirectory: localContext.stateDirectory,
                    environment: localContext.agentLaunchEnvironment,
                    signal: refreshSignal,
                }),
            () => config,
            publishAgentCatalog,
        ),
        (refreshSignal: AbortSignal) =>
            discoverLocalAgentInventory({
                defaultWorkspace,
                dataDirectory: localContext.stateDirectory,
                environment: localContext.agentLaunchEnvironment,
                signal: refreshSignal,
            }).then((inventory) => inventory.readyAgents()),
    );
    return config;
}

async function pairRuntime(
    installation: RuntimeInstallationStore,
    options: PairCommandOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<VerifiedRuntimeConnection> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(options.workspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        dataDirectory: localContext.stateDirectory,
        environment: localContext.agentLaunchEnvironment,
        signal,
    });
    const claim = await claimPairing(options, defaultWorkspace, inventory.readyAgents(), signal);
    const connection = await installation.saveConnection(
        {
            appId: claim.appId,
            channelId: claim.channelId,
            defaultWorkspace,
            pairingId: options.pairingId,
            relayOrigin: options.relayOrigin,
            runtimeCredential: claim.runtimeCredential,
            runtimeId: claim.runtimeId,
        },
        signal,
    );
    return connection;
}

export async function pairRuntimeConnection(
    installation: RuntimeInstallationStore,
    options: MobiusRuntimePairingOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<VerifiedRuntimeConnection> {
    return await pairRuntime(
        installation,
        {
            code: parsePairingCode(options.pairingCode),
            pairingId: options.pairingId.length === 0 ? "" : validatePairingId(options.pairingId),
            relayOrigin: parseRelayOrigin(options.relayOrigin),
            workspace: options.defaultWorkspace,
        },
        signal,
        environment,
    );
}

export async function prepareRuntimeConnection(
    installation: RuntimeInstallationStore,
    connection: VerifiedRuntimeConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
    maxAcpProcesses: number,
): Promise<RuntimeConfig> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment, maxAcpProcesses);
    const defaultWorkspace = await resolveDefaultWorkspace(connection.defaultWorkspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        dataDirectory: localContext.stateDirectory,
        environment: localContext.agentLaunchEnvironment,
        signal,
    });
    return buildSavedRuntimeConfig(connection, defaultWorkspace, inventory, localContext);
}
