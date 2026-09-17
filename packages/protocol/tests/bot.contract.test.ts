import { describe, expect, it } from "vitest";
import {
    AcceptedOutboundMessage,
    ActiveBot,
    ActiveBotConversation,
    ActiveBotDeliveryTarget,
    type AgentExecutionConfiguration,
    BotConnectionCredential,
    BotConnectionGrant,
    BotConnectionReplyRoute,
    BotExecution,
    BotExecutionCapability,
    BotSessionPromptCommand,
    ConnectedBotConversation,
    DisabledBotDeliveryTarget,
    DraftBot,
    decodeBotSessionPromptCommand,
    encodeBotSessionPromptCommand,
    OwnerBotConversation,
    ProtocolMessageError,
    ProvisioningBotConversation,
    QueuedOutboundMessage,
} from "../src/index.ts";

const executionConfiguration: AgentExecutionConfiguration = {
    model: {
        booleanValue: false,
        configId: "model",
        value: "test-large",
        valueType: "select",
    },
    permissionMode: "workspace-write",
    reasoningEffort: {
        booleanValue: false,
        configId: "reasoning_effort",
        value: "high",
        valueType: "select",
    },
};

describe("Bot protocol", () => {
    it("Given draft and active Bot resources, When clients inspect lifecycle state, Then each concrete class exposes only fields valid in that state", () => {
        const draft = new DraftBot(
            "bot_alpha",
            "project_alpha",
            "profile_alpha_1",
            1,
            "2026-09-08T08:00:00.000Z",
            "2026-09-08T08:00:00.000Z",
        );
        const active = new ActiveBot(
            "bot_alpha",
            "project_alpha",
            "profile_alpha_1",
            "behavior_alpha_1",
            "binding_alpha_1",
            2,
            "2026-09-08T08:00:00.000Z",
            "2026-09-08T08:01:00.000Z",
        );

        expect(draft.lifecycle).toBe("draft");
        expect(Object.hasOwn(draft, "activeBehaviorRevisionId")).toBe(false);
        expect(Object.hasOwn(draft, "activeBindingId")).toBe(false);
        expect(active).toMatchObject({
            activeBehaviorRevisionId: "behavior_alpha_1",
            activeBindingId: "binding_alpha_1",
            lifecycle: "active",
        });
    });

    it("Given a Bot turn is accepted, When its daemon decodes the dispatch, Then the pinned Bot and capability cannot be replaced by prompt fields", () => {
        const command = new BotSessionPromptCommand(
            "session_alpha",
            "message_alpha",
            "codex",
            "binding_alpha_1",
            "default",
            [],
            [],
            [],
            "Complete the task",
            "execution_alpha",
            "capability_alpha",
            "secret_alpha_secret_alpha_secret_12",
            "2026-09-08T08:30:00.000Z",
            "bot_alpha",
            "conversation_alpha",
            "turn_alpha",
            "behavior_alpha_1",
            1,
            "Follow the approved project policy.",
            "a".repeat(64),
            [
                {
                    alias: "team-notifications",
                    deliveryTargetId: "target_alpha",
                },
            ],
            new BotConnectionReplyRoute("connection_alpha", "target_alpha"),
            executionConfiguration,
            [
                {
                    booleanValue: true,
                    configId: "fast_mode",
                    value: "",
                    valueType: "boolean",
                },
            ],
        );

        expect(decodeBotSessionPromptCommand(encodeBotSessionPromptCommand(command))).toEqual(command);
        expect(JSON.parse(encodeBotSessionPromptCommand(command))).toMatchObject({
            executionConfiguration,
            sessionConfigurations: [
                {
                    booleanValue: true,
                    configId: "fast_mode",
                    value: "",
                    valueType: "boolean",
                },
            ],
        });

        const encoded: unknown = JSON.parse(encodeBotSessionPromptCommand(command));
        if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
            throw new Error("Expected an encoded Bot command object");
        }
        Reflect.set(encoded, "providerDestination", "C123");
        expect(() => decodeBotSessionPromptCommand(JSON.stringify(encoded))).toThrow(ProtocolMessageError);
    });

    it("Given Bot resources cross subsystem boundaries, When their domain values are created, Then every identity and revision remains explicit and readonly by state", () => {
        const createdAt = "2026-09-08T08:00:00.000Z";
        const provisioning = new ProvisioningBotConversation(
            "conversation_alpha",
            "bot_alpha",
            "behavior_alpha_1",
            "binding_alpha_1",
            1,
            "session_alpha",
            "owner_alpha",
            "Alpha conversation",
            createdAt,
        );
        const active = new ActiveBotConversation(provisioning, createdAt);
        const ownerConversation = new OwnerBotConversation(active, createdAt);
        const connectedConversation = new ConnectedBotConversation(
            active,
            createdAt,
            "connection_alpha",
            "target_alpha",
        );
        const execution = new BotExecution(
            "execution_alpha",
            "bot_alpha",
            "conversation_alpha",
            "turn_alpha",
            "behavior_alpha_1",
            "binding_alpha_1",
            1,
            "runtime_alpha",
            "2026-09-08T08:30:00.000Z",
        );
        const capability = new BotExecutionCapability(
            "capability_alpha",
            execution,
            ["target_alpha"],
            "outbound-message:create",
            16,
            "2026-09-08T08:30:00.000Z",
        );
        const credential = new BotConnectionCredential(
            "credential_alpha",
            "connection_alpha",
            "a".repeat(64),
            createdAt,
            "2026-10-08T08:00:00.000Z",
            createdAt,
        );
        const grant = new BotConnectionGrant(
            "grant_alpha",
            "bot_alpha",
            "connector-alpha",
            ["inbound-message:create"],
            "b".repeat(64),
            "2026-09-08T08:10:00.000Z",
        );
        const target = new ActiveBotDeliveryTarget(
            "target_alpha",
            "bot_alpha",
            "connection_alpha",
            "team-notifications",
            1,
            1,
            true,
            createdAt,
        );
        const disabledTarget = new DisabledBotDeliveryTarget(target, "2026-09-08T08:05:00.000Z");
        const accepted = new AcceptedOutboundMessage(
            "outbound_alpha",
            "bot_alpha",
            "conversation_alpha",
            "turn_alpha",
            "behavior_alpha_1",
            "binding_alpha_1",
            1,
            "execution_alpha",
            "target_alpha",
            "completion_alpha",
            "Completed",
            createdAt,
            "2026-09-15T08:00:00.000Z",
        );
        const queued = new QueuedOutboundMessage(accepted, 1);

        expect(ownerConversation).toMatchObject({
            bindingId: "binding_alpha_1",
            creatorKind: "owner",
            replyRoute: { kind: "owner" },
        });
        expect(connectedConversation).toMatchObject({
            bindingId: "binding_alpha_1",
            connectionId: "connection_alpha",
            replyRoute: { deliveryTargetId: "target_alpha", kind: "connection" },
        });
        expect(capability).toMatchObject({
            behaviorRevisionId: execution.behaviorRevisionId,
            bindingId: execution.bindingId,
            botId: execution.botId,
            operation: "outbound-message:create",
            usageLimit: 16,
        });
        expect(credential.secretDigest).toHaveLength(64);
        expect(grant).toMatchObject({ audience: "connector-alpha", botId: "bot_alpha" });
        expect(disabledTarget).toMatchObject({
            deliveryTargetId: target.deliveryTargetId,
            lifecycle: "disabled",
            lifecycleRevision: 2,
        });
        expect(queued).toMatchObject({
            behaviorRevisionId: "behavior_alpha_1",
            bindingId: "binding_alpha_1",
            conversationId: "conversation_alpha",
            expiresAt: "2026-09-15T08:00:00.000Z",
            idempotencyKey: "completion_alpha",
            state: "queued",
            turnId: "turn_alpha",
        });
    });
});
