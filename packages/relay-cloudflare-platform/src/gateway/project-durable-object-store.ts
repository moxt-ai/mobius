import {
    type AccessGrantRedemption,
    PairingDirectoryError,
    type RuntimePairingRequest,
} from "@moxt-ai/mobius-relay-core/contracts";
import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";
import { logger } from "@moxt-ai/mobius-relay-core/logging";
import type { ProjectLocationHint } from "@moxt-ai/mobius-sdk/protocol";
import type { ProjectDO } from "../durable-objects/project-do.ts";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import type { PlatformProjectStore, PlatformProjectStores } from "../infra/platform-project-store.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

type ProjectStub = DurableObjectStub<ProjectDO>;

/**
 * A Project's store reached through its Project Durable Object. Every operation executes there as one unit;
 * cancelling or timing out here stops waiting for the result but cannot undo an operation already delivered.
 */
class ProjectDurableObjectStore implements PlatformProjectStore {
    readonly #namespace: DurableObjectNamespace<ProjectDO>;
    readonly #projectId: string;
    readonly #locationHint: ProjectLocationHint;
    #stub: ProjectStub | null = null;

    constructor(namespace: DurableObjectNamespace<ProjectDO>, projectId: string, locationHint: ProjectLocationHint) {
        this.#namespace = namespace;
        this.#projectId = projectId;
        this.#locationHint = locationHint;
    }

    private readonly call = async <Value>(
        operation: string,
        invoke: (stub: ProjectStub, projectId: string) => Promise<Value>,
        signal: AbortSignal,
    ): Promise<Value> => {
        signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), OPERATION_TIMEOUT_MILLISECONDS);
        const deadline = AbortSignal.any([signal, timeout.signal]);
        let abort = (): void => {};
        try {
            this.#stub ??= this.#namespace.getByName(this.#projectId, { locationHint: this.#locationHint });
            const value = await Promise.race([
                invoke(this.#stub, this.#projectId),
                new Promise<never>((_resolve, reject) => {
                    abort = () => reject(deadline.reason);
                    deadline.addEventListener("abort", abort, { once: true });
                    if (deadline.aborted) {
                        abort();
                    }
                }),
            ]);
            deadline.throwIfAborted();
            return value;
        } catch (cause) {
            signal.throwIfAborted();
            // A failed call may have broken the stub; the next operation connects again.
            this.#stub = null;
            logger.error(
                {
                    event: "project_database_request_failed",
                    durableObjectClass: "ProjectDO",
                    durableObjectId: this.#namespace.idFromName(this.#projectId).toString(),
                    projectId: this.#projectId,
                    operation,
                    err: cause,
                },
                "Project database request failed",
            );
            throw new DatabaseError(
                timeout.signal.aborted ? "database_timeout" : "database_unavailable",
                "Project storage is unavailable",
                { cause },
            );
        } finally {
            clearTimeout(timer);
            deadline.removeEventListener("abort", abort);
        }
    };

    readonly authenticateHost: PlatformProjectStore["authenticateHost"] = (channelId, tokenHash, now, signal) =>
        this.call(
            "authenticateHost",
            (stub, projectId) => stub.authenticateHost(projectId, channelId, tokenHash, now),
            signal,
        );

    readonly isHostCredentialActive: PlatformProjectStore["isHostCredentialActive"] = (identity, signal) =>
        this.call(
            "isHostCredentialActive",
            (stub, projectId) => stub.isHostCredentialActive(projectId, identity),
            signal,
        );

    readonly openControlHost: PlatformProjectStore["openControlHost"] = (value, signal) =>
        this.call("openControlHost", (stub, projectId) => stub.openControlHost(projectId, value), signal);

    readonly closeControlHost: PlatformProjectStore["closeControlHost"] = (channelId, credentialId, signal) =>
        this.call(
            "closeControlHost",
            (stub, projectId) => stub.closeControlHost(projectId, channelId, credentialId),
            signal,
        );

    readonly discardControlHost: PlatformProjectStore["discardControlHost"] = (credentialId, signal) =>
        this.call("discardControlHost", (stub, projectId) => stub.discardControlHost(projectId, credentialId), signal);

    readonly listLinkedDevices: PlatformProjectStore["listLinkedDevices"] = (channelId, signal) =>
        this.call("listLinkedDevices", (stub, projectId) => stub.listLinkedDevices(projectId, channelId), signal);

    readonly revokeLinkedDevice: PlatformProjectStore["revokeLinkedDevice"] = (channelId, credentialId, now, signal) =>
        this.call(
            "revokeLinkedDevice",
            (stub, projectId) => stub.revokeLinkedDevice(projectId, channelId, credentialId, now),
            signal,
        );

    readonly createAccessGrant: PlatformProjectStore["createAccessGrant"] = (value, signal) =>
        this.call("createAccessGrant", (stub, projectId) => stub.createAccessGrant(projectId, value), signal);

    readonly redeemAccessGrant: PlatformProjectStore["redeemAccessGrant"] = (value, signal) =>
        this.call(
            "redeemAccessGrant",
            async (stub, projectId): Promise<AccessGrantRedemption> => await stub.redeemAccessGrant(projectId, value),
            signal,
        );

    readonly createBrowserCredential: PlatformProjectStore["createBrowserCredential"] = (value, signal) =>
        this.call(
            "createBrowserCredential",
            (stub, projectId) => stub.createBrowserCredential(projectId, value),
            signal,
        );

    readonly revokeBrowserCredential: PlatformProjectStore["revokeBrowserCredential"] = (credentialId, now, signal) =>
        this.call(
            "revokeBrowserCredential",
            (stub, projectId) => stub.revokeBrowserCredential(projectId, credentialId, now),
            signal,
        );

    readonly readDaemon: PlatformProjectStore["readDaemon"] = (channelId, tokenHash, signal) =>
        this.call("readDaemon", (stub, projectId) => stub.readDaemon(projectId, channelId, tokenHash), signal);

    readonly updateAgentCatalog: PlatformProjectStore["updateAgentCatalog"] = (channelId, tokenHash, agents, signal) =>
        this.call(
            "updateAgentCatalog",
            (stub, projectId) => stub.updateAgentCatalog(projectId, channelId, tokenHash, agents),
            signal,
        );

    readonly isRuntimeActive: PlatformProjectStore["isRuntimeActive"] = (runtimeId, signal) =>
        this.call("isRuntimeActive", (stub, projectId) => stub.isRuntimeActive(projectId, runtimeId), signal);

    readonly readRuntime: PlatformProjectStore["readRuntime"] = (runtimeId, signal) =>
        this.call("readRuntime", (stub, projectId) => stub.readRuntime(projectId, runtimeId), signal);

    readonly listRuntimes: PlatformProjectStore["listRuntimes"] = (signal) =>
        this.call("listRuntimes", (stub, projectId) => stub.listRuntimes(projectId), signal);

    readonly readChannel: PlatformProjectStore["readChannel"] = (channelId, signal) =>
        this.call("readChannel", (stub, projectId) => stub.readChannel(projectId, channelId), signal);

    readonly requestRuntimePairing: PlatformProjectStore["requestRuntimePairing"] = (value, signal) =>
        this.call(
            "requestRuntimePairing",
            async (stub, projectId): Promise<RuntimePairingRequest> =>
                await stub.requestRuntimePairing(projectId, value),
            signal,
        );

    readonly readRuntimePairing: PlatformProjectStore["readRuntimePairing"] = (pairingId, signal) =>
        this.call("readRuntimePairing", (stub, projectId) => stub.readRuntimePairing(projectId, pairingId), signal);

    readonly readPairingCode: PlatformProjectStore["readPairingCode"] = (codeHash, signal) =>
        this.call("readPairingCode", (stub, projectId) => stub.readPairingCode(projectId, codeHash), signal);

    readonly claimPairing: PlatformProjectStore["claimPairing"] = (value, signal) =>
        this.call("claimPairing", (stub, projectId) => stub.claimPairing(projectId, value), signal);

    readonly revokeRuntime: PlatformProjectStore["revokeRuntime"] = (value, signal) =>
        this.call("revokeRuntime", (stub, projectId) => stub.revokeRuntime(projectId, value), signal);

    readonly findCredential: PlatformProjectStore["findCredential"] = (credential, signal) =>
        this.call("findCredential", (stub, projectId) => stub.findCredential(projectId, credential), signal);

    readonly findRuntimeCredential: PlatformProjectStore["findRuntimeCredential"] = (tokenHash, signal) =>
        this.call(
            "findRuntimeCredential",
            (stub, projectId) => stub.findRuntimeCredential(projectId, tokenHash),
            signal,
        );

    readonly recordAudit: PlatformProjectStore["recordAudit"] = (audit, signal) =>
        this.call("recordAudit", (stub, projectId) => stub.recordAudit(projectId, audit), signal);

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = (limit, signal) =>
        this.call("listAuditEvents", (stub, projectId) => stub.listAuditEvents(projectId, limit), signal);

    readonly readLegacyCredentialScope: PlatformProjectStore["readLegacyCredentialScope"] = (credentialId, signal) =>
        this.call(
            "readLegacyCredentialScope",
            (stub, projectId) => stub.readLegacyCredentialScope(projectId, credentialId),
            signal,
        );
}

/**
 * Locates Project stores. Inside a Project Durable Object its own Project resolves to the local store; every other
 * Project resolves to its own Durable Object.
 */
export class ProjectDurableObjectStores implements PlatformProjectStores {
    readonly #namespace: DurableObjectNamespace<ProjectDO>;
    readonly #local: { readonly projectId: string; readonly store: PlatformProjectStore } | null;
    readonly #remote = new Map<string, PlatformProjectStore>();

    constructor(
        namespace: DurableObjectNamespace<ProjectDO>,
        local: { readonly projectId: string; readonly store: PlatformProjectStore } | null = null,
    ) {
        this.#namespace = namespace;
        this.#local = local;
    }

    readonly forProject: PlatformProjectStores["forProject"] = (projectId) => {
        if (this.#local?.projectId === projectId) {
            return this.#local.store;
        }
        const existing = this.#remote.get(projectId);
        if (existing !== undefined) {
            return existing;
        }
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        const store = new ProjectDurableObjectStore(this.#namespace, projectId, placement.locationHint);
        this.#remote.set(projectId, store);
        return store;
    };

    readonly resolve: PlatformProjectStores["resolve"] = (placement) => {
        if (!placement.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return this.forProject(placement.shard.d1ShardId);
    };
}
