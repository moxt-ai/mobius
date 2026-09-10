import { ActiveBot, ArchivedBot, DraftBot, SuspendedBot } from "@moxt-ai/mobius-protocol";
import { completionPolicy, stringArray } from "../../entity/bot/bot-binding.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import type { BotConnectionStorage } from "../../storage/bot-connection-storage.ts";
import type { BotControlStorage } from "../../storage/bot-control-storage.ts";

function timestamp(value: unknown, message = "The Bot record is invalid"): string {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new BotApiError("bot_service_unavailable", message, "unavailable");
    }
    return new Date(value).toISOString();
}

export function botResource(row: Awaited<ReturnType<BotControlStorage["readBot"]>>): object {
    if (row === null) {
        throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
    }
    const createdAt = timestamp(row.created_at);
    const updatedAt = timestamp(row.updated_at);
    let resource: object;
    if (row.lifecycle === "draft") {
        resource = new DraftBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
        );
    } else if (
        row.lifecycle === "active" &&
        typeof row.active_behavior_revision_id === "string" &&
        typeof row.active_binding_id === "string"
    ) {
        resource = new ActiveBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.active_behavior_revision_id,
            row.active_binding_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
        );
    } else if (
        row.lifecycle === "suspended" &&
        typeof row.active_behavior_revision_id === "string" &&
        typeof row.active_binding_id === "string"
    ) {
        resource = new SuspendedBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.active_behavior_revision_id,
            row.active_binding_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
            timestamp(row.suspended_at),
        );
    } else if (row.lifecycle === "archived") {
        resource = new ArchivedBot(
            row.bot_id,
            row.project_id,
            row.current_profile_revision_id,
            row.lifecycle_revision,
            createdAt,
            updatedAt,
            timestamp(row.archived_at),
        );
    } else {
        throw new BotApiError("bot_service_unavailable", "The Bot lifecycle is invalid", "unavailable");
    }
    return {
        ...resource,
        avatarRef: row.avatar_ref,
        description: row.description,
        displayName: row.display_name,
        profileRevision: row.profile_revision_number,
    };
}

function objectValue(encoded: string, message: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", message, "unavailable", { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BotApiError("bot_service_unavailable", message, "unavailable");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

export function behaviorResource(row: Awaited<ReturnType<BotControlStorage["listBehaviorRevisions"]>>[number]): object {
    const resource = {
        agentConfiguration: objectValue(row.agent_configuration_json, "The behavior configuration is invalid"),
        behaviorRevisionId: row.behavior_revision_id,
        botId: row.bot_id,
        contentDigest: row.content_digest,
        createdAt: timestamp(row.created_at),
        instructions: row.instructions,
        lifecycle: row.lifecycle,
        requiredCapabilities: stringArray(row.required_capabilities_json, "The behavior requirements are invalid"),
        revisionNumber: row.revision_number,
    };
    if (row.lifecycle === "proposed" || row.lifecycle === "awaiting_local_approval") {
        return resource;
    }
    if (row.lifecycle === "approved") {
        return { ...resource, approvedAt: timestamp(row.approved_at) };
    }
    if (row.lifecycle === "retired") {
        return { ...resource, retiredAt: timestamp(row.retired_at) };
    }
    throw new BotApiError("bot_service_unavailable", "The Bot behavior lifecycle is invalid", "unavailable");
}

export function bindingResource(row: Awaited<ReturnType<BotControlStorage["listExecutionBindings"]>>[number]): object {
    const resource = {
        agentConfigRevision: row.agent_config_revision,
        agentRef: row.agent_ref,
        allowedDeliveryTargetIds: stringArray(row.allowed_delivery_target_ids_json, "The binding targets are invalid"),
        behaviorRevisionId: row.behavior_revision_id,
        bindingId: row.binding_id,
        bindingRevision: row.binding_revision,
        botId: row.bot_id,
        completionPolicy: completionPolicy(row.completion_policy_json),
        createdAt: timestamp(row.created_at),
        lifecycle: row.lifecycle,
        runtimeId: row.runtime_id,
        workspaceRef: row.workspace_ref,
    };
    if (row.lifecycle === "requested") {
        return resource;
    }
    if (row.lifecycle === "approved") {
        return { ...resource, approvedAt: timestamp(row.approved_at) };
    }
    if (
        row.lifecycle === "unavailable" &&
        typeof row.unavailable_code === "string" &&
        typeof row.unavailable_message === "string"
    ) {
        return {
            ...resource,
            code: row.unavailable_code,
            message: row.unavailable_message,
            unavailableAt: timestamp(row.unavailable_at),
        };
    }
    if (row.lifecycle === "revoked") {
        return { ...resource, revokedAt: timestamp(row.revoked_at) };
    }
    throw new BotApiError("bot_service_unavailable", "The Bot binding lifecycle is invalid", "unavailable");
}

export function connectionResource(
    row: Awaited<ReturnType<BotConnectionStorage["listForProject"]>>["connections"][number],
): object {
    const resource = {
        audience: row.audience,
        botId: row.bot_id,
        connectionId: row.connection_id,
        connectorPrincipalId: row.connector_principal_id,
        createdAt: timestamp(row.created_at, "The Bot connection record is invalid"),
        label: row.label,
        lifecycle: row.lifecycle,
        lifecycleRevision: row.lifecycle_revision,
        scopes: stringArray(row.scopes_json, "The Bot connection grant is invalid"),
    };
    if (row.lifecycle === "active") {
        return { ...resource, lastUsedAt: timestamp(row.last_used_at, "The Bot connection record is invalid") };
    }
    if (row.lifecycle === "revoked") {
        return { ...resource, revokedAt: timestamp(row.revoked_at, "The Bot connection record is invalid") };
    }
    throw new BotApiError("bot_service_unavailable", "The Bot connection lifecycle is invalid", "unavailable");
}

export function targetResource(
    row: Awaited<ReturnType<BotConnectionStorage["listForProject"]>>["deliveryTargets"][number],
): object {
    const resource = {
        alias: row.alias,
        botId: row.bot_id,
        connectionId: row.connection_id,
        createdAt: timestamp(row.created_at, "The Bot connection record is invalid"),
        deliveryTargetId: row.delivery_target_id,
        lifecycle: row.lifecycle,
        lifecycleRevision: row.lifecycle_revision,
        outboundPolicyRevision: row.outbound_policy_revision,
        ownerApproved: row.owner_approved === 1,
        updatedAt: timestamp(row.updated_at, "The Bot connection record is invalid"),
    };
    if (row.lifecycle === "active") {
        return resource;
    }
    if (row.lifecycle === "disabled") {
        return { ...resource, disabledAt: timestamp(row.disabled_at, "The Bot connection record is invalid") };
    }
    throw new BotApiError("bot_service_unavailable", "The Bot delivery target lifecycle is invalid", "unavailable");
}
