import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
    type BotExecutionBindingApprovalRequest,
    BotExecutionBindingApprovedEvent,
    type BotSessionPromptCommand,
} from "@moxt-ai/mobius-protocol";

import type { LocalAgentCatalog, LocalAgentDefinition } from "../agent-catalog/local-agent.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { revalidateExecutable } from "../process/executable.ts";

const LOCAL_BOT_GRANT_LIFETIME_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;

export class LocalBotAuthorizationError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "LocalBotAuthorizationError";
    }
}

export class LocalBotGrant {
    readonly agent: LocalAgentDefinition;
    readonly agentIdentityDigest: string;
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly behaviorDigest: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly expiresAt: number;
    readonly localGrantId: string;
    readonly revocationEpoch: number;
    readonly workspaceIdentityDigest: string;
    readonly workspacePath: string;
    readonly workspaceRef: string;

    constructor(
        localGrantId: string,
        botId: string,
        behaviorRevisionId: string,
        behaviorDigest: string,
        bindingId: string,
        bindingRevision: number,
        agent: LocalAgentDefinition,
        agentIdentityDigest: string,
        workspaceRef: string,
        workspacePath: string,
        workspaceIdentityDigest: string,
        allowedDeliveryTargetIds: readonly string[],
        expiresAt: number,
        revocationEpoch: number,
    ) {
        this.localGrantId = localGrantId;
        this.botId = botId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.behaviorDigest = behaviorDigest;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.agent = agent;
        this.agentIdentityDigest = agentIdentityDigest;
        this.workspaceRef = workspaceRef;
        this.workspacePath = workspacePath;
        this.workspaceIdentityDigest = workspaceIdentityDigest;
        this.allowedDeliveryTargetIds = Object.freeze([...allowedDeliveryTargetIds]);
        this.expiresAt = expiresAt;
        this.revocationEpoch = revocationEpoch;
    }
}

interface GrantResolution {
    readonly agent: LocalAgentDefinition;
    readonly agentIdentityDigest: string;
    readonly workspaceIdentityDigest: string;
    readonly workspacePath: string;
}

function digest(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function agentDigest(agent: LocalAgentDefinition): string {
    return digest(
        JSON.stringify({
            adapter: agent.adapterIdentity,
            agent: agent.agentIdentity,
            agentVersion: agent.agentVersion,
            arguments: agent.arguments,
            id: agent.id,
        }),
    );
}

async function workspaceDigest(path: string): Promise<string> {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
        throw new LocalBotAuthorizationError("binding_incompatible", "The Bot workspace is not a directory");
    }
    return digest(
        JSON.stringify({
            changedAtMilliseconds: metadata.ctimeMs,
            device: metadata.dev,
            inode: metadata.ino,
            path,
        }),
    );
}

function exactTargets(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const expected = [...left].sort();
    const actual = [...right].sort();
    return expected.every((target, index) => target === actual[index]);
}

function rowString(row: object, key: string): string {
    const value = Reflect.get(row, key);
    if (typeof value !== "string") {
        throw new LocalBotAuthorizationError("local_grant_invalid", "The local Bot grant is invalid");
    }
    return value;
}

function rowInteger(row: object, key: string): number {
    const value = Reflect.get(row, key);
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new LocalBotAuthorizationError("local_grant_invalid", "The local Bot grant is invalid");
    }
    return value;
}

function parseTargets(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new LocalBotAuthorizationError("local_grant_invalid", "The local Bot grant is invalid", { cause });
    }
    if (!Array.isArray(value) || value.some((target) => typeof target !== "string")) {
        throw new LocalBotAuthorizationError("local_grant_invalid", "The local Bot grant is invalid");
    }
    return value.filter((target) => typeof target === "string");
}

export class LocalBotGrantStore {
    readonly #database: DatabaseSync;

    constructor(path: string) {
        this.#database = new DatabaseSync(path);
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS local_bot_grants (
            local_grant_id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            behavior_revision_id TEXT NOT NULL,
            behavior_digest TEXT NOT NULL,
            binding_id TEXT NOT NULL UNIQUE,
            binding_revision INTEGER NOT NULL,
            agent_ref TEXT NOT NULL,
            agent_identity_digest TEXT NOT NULL,
            workspace_ref TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            workspace_identity_digest TEXT NOT NULL,
            allowed_delivery_target_ids_json TEXT NOT NULL,
            unattended_policy_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revocation_epoch INTEGER NOT NULL DEFAULT 0,
            revoked_at INTEGER
          ) STRICT;
          CREATE TABLE IF NOT EXISTS local_bot_binding_resolutions (
            request_id TEXT PRIMARY KEY,
            binding_id TEXT NOT NULL,
            local_grant_id TEXT NOT NULL,
            resolved_at INTEGER NOT NULL,
            result TEXT NOT NULL CHECK (result IN ('approved', 'unavailable')),
            error_code TEXT,
            error_message TEXT
          ) STRICT;
        `);
    }

    readonly approve = async (
        request: BotExecutionBindingApprovalRequest,
        catalog: LocalAgentCatalog,
        directories: WorkspaceDirectoryService,
        bindingAuthorityId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<BotExecutionBindingApprovedEvent> => {
        signal.throwIfAborted();
        const existing = this.#database
            .prepare(
                `SELECT grants.* FROM local_bot_binding_resolutions AS resolutions
                   INNER JOIN local_bot_grants AS grants
                     ON grants.local_grant_id = resolutions.local_grant_id
                  WHERE resolutions.request_id = ? AND resolutions.binding_id = ?
                    AND resolutions.result = 'approved'`,
            )
            .get(request.requestId, request.bindingId);
        if (existing !== undefined) {
            return new BotExecutionBindingApprovedEvent(
                request.requestId,
                request.botId,
                request.behaviorRevisionId,
                request.bindingId,
                request.bindingRevision,
                rowString(existing, "local_grant_id"),
                rowString(existing, "agent_identity_digest"),
                rowString(existing, "workspace_identity_digest"),
            );
        }
        const resolved = await this.resolveProposal(request, catalog, directories, bindingAuthorityId, signal);
        const localGrantId = `lbg_${randomUUID()}`;
        const expiresAt = now + LOCAL_BOT_GRANT_LIFETIME_MILLISECONDS;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            this.#database
                .prepare(
                    `INSERT INTO local_bot_grants (
                       local_grant_id, bot_id, behavior_revision_id, behavior_digest,
                       binding_id, binding_revision, agent_ref,
                       agent_identity_digest, workspace_ref, workspace_path,
                       workspace_identity_digest, allowed_delivery_target_ids_json,
                       unattended_policy_json, created_at, expires_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    localGrantId,
                    request.botId,
                    request.behaviorRevisionId,
                    request.behaviorDigest,
                    request.bindingId,
                    request.bindingRevision,
                    request.agentRef,
                    resolved.agentIdentityDigest,
                    request.workspaceRef,
                    resolved.workspacePath,
                    resolved.workspaceIdentityDigest,
                    JSON.stringify(request.allowedDeliveryTargets.map((target) => target.deliveryTargetId)),
                    JSON.stringify({ localSideEffects: "owner-approval-required" }),
                    now,
                    expiresAt,
                );
            this.#database
                .prepare(
                    `INSERT INTO local_bot_binding_resolutions (
                       request_id, binding_id, local_grant_id, resolved_at, result
                     ) VALUES (?, ?, ?, ?, 'approved')`,
                )
                .run(request.requestId, request.bindingId, localGrantId, now);
            this.#database.exec("COMMIT");
        } catch (cause) {
            this.#database.exec("ROLLBACK");
            throw cause;
        }
        signal.throwIfAborted();
        return new BotExecutionBindingApprovedEvent(
            request.requestId,
            request.botId,
            request.behaviorRevisionId,
            request.bindingId,
            request.bindingRevision,
            localGrantId,
            resolved.agentIdentityDigest,
            resolved.workspaceIdentityDigest,
        );
    };

    readonly resolveExecution = async (
        command: BotSessionPromptCommand,
        catalog: LocalAgentCatalog,
        directories: WorkspaceDirectoryService,
        bindingAuthorityId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<LocalBotGrant> => {
        signal.throwIfAborted();
        const row = this.#database
            .prepare(
                `SELECT * FROM local_bot_grants
                  WHERE local_grant_id = ? AND bot_id = ?
                    AND behavior_revision_id = ? AND behavior_digest = ?
                    AND binding_id = ? AND binding_revision = ?
                    AND agent_ref = ?
                    AND revoked_at IS NULL AND expires_at > ?`,
            )
            .get(
                command.localGrantId,
                command.botId,
                command.behaviorRevisionId,
                command.behaviorDigest,
                command.bindingId,
                command.bindingRevision,
                command.agentId,
                now,
            );
        if (row === undefined) {
            throw new LocalBotAuthorizationError(
                "binding_not_approved",
                "The Bot execution binding is not locally approved",
            );
        }
        const approvedTargets = parseTargets(rowString(row, "allowed_delivery_target_ids_json"));
        const requestedTargets = command.allowedDeliveryTargets.map((target) => target.deliveryTargetId);
        if (!exactTargets(approvedTargets, requestedTargets)) {
            throw new LocalBotAuthorizationError(
                "binding_not_approved",
                "The Bot execution target policy changed after local approval",
            );
        }
        const agent = catalog.find(command.agentId);
        const [adapterUnchanged, agentUnchanged] = await Promise.all([
            revalidateExecutable(agent.adapterIdentity),
            revalidateExecutable(agent.agentIdentity),
        ]);
        signal.throwIfAborted();
        const workspaceRef = rowString(row, "workspace_ref");
        const workspacePath = await directories.resolve(bindingAuthorityId, workspaceRef, signal);
        const currentAgentDigest = agentDigest(agent);
        const currentWorkspaceDigest = await workspaceDigest(workspacePath);
        signal.throwIfAborted();
        if (
            !adapterUnchanged ||
            !agentUnchanged ||
            currentAgentDigest !== rowString(row, "agent_identity_digest") ||
            currentWorkspaceDigest !== rowString(row, "workspace_identity_digest") ||
            workspacePath !== rowString(row, "workspace_path")
        ) {
            this.revoke(rowString(row, "local_grant_id"), now);
            throw new LocalBotAuthorizationError(
                "binding_not_approved",
                "The Bot execution target changed and requires local approval",
            );
        }
        if (command.behaviorInstructions.length > 0 && !agent.capabilities.embeddedContextPrompt) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent cannot apply the approved Bot behavior",
            );
        }
        return new LocalBotGrant(
            rowString(row, "local_grant_id"),
            command.botId,
            command.behaviorRevisionId,
            command.behaviorDigest,
            command.bindingId,
            command.bindingRevision,
            agent,
            currentAgentDigest,
            workspaceRef,
            workspacePath,
            currentWorkspaceDigest,
            approvedTargets,
            rowInteger(row, "expires_at"),
            rowInteger(row, "revocation_epoch"),
        );
    };

    readonly recordUnavailable = (
        request: BotExecutionBindingApprovalRequest,
        code: string,
        message: string,
        now: number,
    ): void => {
        this.#database
            .prepare(
                `INSERT OR IGNORE INTO local_bot_binding_resolutions (
                   request_id, binding_id, local_grant_id, resolved_at,
                   result, error_code, error_message
                 ) VALUES (?, ?, '', ?, 'unavailable', ?, ?)`,
            )
            .run(request.requestId, request.bindingId, now, code, message);
    };

    readonly close = (): void => {
        this.#database.close();
    };

    private readonly resolveProposal = async (
        request: BotExecutionBindingApprovalRequest,
        catalog: LocalAgentCatalog,
        directories: WorkspaceDirectoryService,
        bindingAuthorityId: string,
        signal: AbortSignal,
    ): Promise<GrantResolution> => {
        const agent = catalog.find(request.agentRef);
        if (request.requiredCapabilities.includes("embedded-context") && !agent.capabilities.embeddedContextPrompt) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent cannot apply embedded Bot context",
            );
        }
        if (request.requiredCapabilities.some((capability) => capability !== "embedded-context")) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The Bot requires an unsupported local Agent capability",
            );
        }
        const [adapterUnchanged, agentUnchanged] = await Promise.all([
            revalidateExecutable(agent.adapterIdentity),
            revalidateExecutable(agent.agentIdentity),
        ]);
        signal.throwIfAborted();
        if (!adapterUnchanged || !agentUnchanged) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent executable changed before approval",
            );
        }
        const workspacePath = await directories.resolve(bindingAuthorityId, request.workspaceRef, signal);
        return {
            agent,
            agentIdentityDigest: agentDigest(agent),
            workspaceIdentityDigest: await workspaceDigest(workspacePath),
            workspacePath,
        };
    };

    private readonly revoke = (localGrantId: string, now: number): void => {
        this.#database
            .prepare(
                `UPDATE local_bot_grants
                    SET revoked_at = COALESCE(revoked_at, ?), revocation_epoch = revocation_epoch + 1
                  WHERE local_grant_id = ? AND revoked_at IS NULL`,
            )
            .run(now, localGrantId);
    };
}
