import type { ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { PiRpcEvent, PiRpcProcess } from "../pi-rpc/process.js";
import type { PiAcpClient } from "./client.js";

const questionBase = {
    id: z.string().min(1).max(255),
    title: z.string().max(255),
    timeout: z.number().int().nonnegative().max(2_147_483_647).optional(),
};
const questionSchema = z
    .discriminatedUnion("method", [
        z.object({
            ...questionBase,
            method: z.literal("select"),
            options: z.array(z.string().min(1).max(255)).min(1).max(200).readonly(),
        }),
        z.object({ ...questionBase, method: z.literal("confirm"), message: z.string().max(2_000) }),
        z.object({ ...questionBase, method: z.literal("input"), placeholder: z.string().max(500).optional() }),
        z.object({ ...questionBase, method: z.literal("editor"), prefill: z.string().max(10_000).optional() }),
    ])
    .readonly();
type Question = z.infer<typeof questionSchema>;
const QUESTION_TIMEOUT_MS = 3_600_000;

function questionField(question: Question): ElicitationPropertySchema {
    const title = question.title || "Answer";
    switch (question.method) {
        case "select":
            return { type: "string", title, enum: [...question.options] };
        case "confirm":
            return {
                type: "string",
                title,
                oneOf: [
                    { const: "yes", title: "Yes" },
                    { const: "no", title: "No" },
                ],
            };
        case "input":
            return { type: "string", title, description: question.placeholder, maxLength: 10_000 };
        case "editor":
            return {
                type: "string",
                title,
                default: question.prefill,
                maxLength: 10_000,
                _meta: { "io.mobius/multiline": true },
            };
    }
}

/** Owns native dialog lifetimes within the ACP turn that requested them. */
export class PiExtensionQuestions {
    private turn: { readonly controller: AbortController; readonly requestIds: Set<string> } | null = null;

    constructor(
        private readonly sessionId: string,
        private readonly conn: PiAcpClient,
        private readonly proc: PiRpcProcess,
        private readonly notify: (text: string) => Promise<void>,
    ) {}

    startTurn(): void {
        this.endTurn();
        this.turn = { controller: new AbortController(), requestIds: new Set() };
    }

    endTurn(): void {
        this.turn?.controller.abort();
        this.turn = null;
    }

    async handle(event: PiRpcEvent): Promise<void> {
        // Status, widget, title and editor updates are fire-and-forget in Pi RPC.
        if (
            event.method !== "select" &&
            event.method !== "confirm" &&
            event.method !== "input" &&
            event.method !== "editor"
        ) {
            return;
        }
        if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 255) {
            return;
        }
        const turn = this.turn;
        if (turn?.requestIds.has(event.id)) {
            return;
        }
        turn?.requestIds.add(event.id);
        const parsed = questionSchema.safeParse(event);
        if (!parsed.success) {
            await this.notify(
                "Pi requested a question with unsupported or oversized fields. The question was cancelled without changing its content.",
            );
            await this.proc.sendExtensionUiResponse({ id: event.id, cancelled: true });
            return;
        }
        const question = parsed.data;
        if (turn === null || turn.controller.signal.aborted) {
            await this.proc.sendExtensionUiResponse({ id: question.id, cancelled: true });
            return;
        }
        const deadline = new AbortController();
        const timeout = setTimeout(() => deadline.abort(), question.timeout || QUESTION_TIMEOUT_MS);
        const signal = AbortSignal.any([turn.controller.signal, deadline.signal]);
        let response: Parameters<PiRpcProcess["sendExtensionUiResponse"]>[0] = { id: question.id, cancelled: true };
        try {
            const answer = await this.conn.requestElicitation(
                {
                    sessionId: this.sessionId,
                    mode: "form",
                    message: question.method === "confirm" ? question.message : question.title,
                    requestedSchema: {
                        type: "object",
                        properties: { value: questionField(question) },
                        required: ["value"],
                    },
                },
                signal,
            );
            const content: unknown = answer.action === "accept" ? answer.content : undefined;
            const value = typeof content === "object" && content !== null ? Reflect.get(content, "value") : undefined;
            if (!signal.aborted && typeof value === "string") {
                switch (question.method) {
                    case "select":
                        if (question.options.includes(value)) {
                            response = { id: question.id, value };
                        }
                        break;
                    case "confirm":
                        if (value === "yes" || value === "no") {
                            response = { id: question.id, confirmed: value === "yes" };
                        }
                        break;
                    case "input":
                    case "editor":
                        if (value.length <= 10_000) {
                            response = { id: question.id, value };
                        }
                        break;
                }
            }
        } catch {
            // A closed ACP connection, cancelled turn or deadline cancels the native dialog.
        } finally {
            clearTimeout(timeout);
        }
        await this.proc.sendExtensionUiResponse(response);
    }
}
