import {
    AGENT_MESSAGE_DELTA_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
} from "@moxt-ai/mobius-protocol";
import { BotConversationEvent, BotConversationEventPage } from "../../entity/bot/bot-session.ts";

function payload(event: BotConversationEvent): Readonly<Record<string, unknown>> {
    if (event.kind === AGENT_MESSAGE_DELTA_KIND && typeof event.payload["text"] === "string") {
        return { kind: event.kind, text: event.payload["text"] };
    }
    if (event.kind === SESSION_COMPLETED_KIND && typeof event.payload["stopReason"] === "string") {
        return { kind: event.kind, stopReason: event.payload["stopReason"] };
    }
    if (event.kind === SESSION_FAILED_KIND && typeof event.payload["code"] === "string") {
        return { kind: event.kind, code: event.payload["code"] };
    }
    if (event.kind === SESSION_PERMISSION_REQUESTED_KIND) {
        return { kind: event.kind, actionKind: "permission", actionRequired: true };
    }
    if (event.kind === SESSION_PERMISSION_RESOLVED_KIND) {
        return { kind: event.kind, actionKind: "permission", actionRequired: false };
    }
    if (event.kind === SESSION_ELICITATION_REQUESTED_KIND) {
        return { kind: event.kind, actionKind: "elicitation", actionRequired: true };
    }
    if (event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
        return { kind: event.kind, actionKind: "elicitation", actionRequired: false };
    }
    return { kind: event.kind };
}

export function connectorEventPage(page: BotConversationEventPage): BotConversationEventPage {
    return new BotConversationEventPage(
        page.cursor,
        page.events.map(
            (event) =>
                new BotConversationEvent(
                    event.eventId,
                    event.conversationId,
                    event.turnId,
                    event.sequence,
                    event.timestamp,
                    event.behaviorRevisionId,
                    event.kind,
                    payload(event),
                ),
        ),
        page.hasMore,
    );
}
