import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import {
    SESSION_EVENT_KIND,
    type SessionElicitationField,
    type SessionElicitationRequestedEvent,
    type SessionLiveEvent,
    type SessionPermissionRequestedEvent,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import type { LocalSessionConnection } from "../../../runtime/local/session-client.ts";
import { LocalSessionError } from "../../../runtime/local/session-stream.ts";

type Question = SessionElicitationRequestedEvent | SessionPermissionRequestedEvent;
type Answer = string | number | boolean | readonly string[];
type PermissionState = { readonly kind: "permission"; readonly request: SessionPermissionRequestedEvent };
type AnsweringState = {
    readonly kind: "answering";
    readonly request: SessionElicitationRequestedEvent;
    readonly index: number;
    readonly answers: Readonly<Record<string, Answer>>;
    readonly lines: readonly string[];
};
type TerminalState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly commandId: string }
    | PermissionState
    | AnsweringState
    | {
          readonly kind: "submitted";
          readonly commandId: string;
          readonly interactionId: string;
          readonly previous: PermissionState | AnsweringState;
      };

function defaultAnswer(field: SessionElicitationField): Answer {
    switch (field.type) {
        case "boolean":
            return field.defaultBooleanValue;
        case "integer":
        case "number":
            return field.defaultNumberValue;
        case "multiselect": {
            const values: unknown = JSON.parse(field.defaultStringValue || "[]");
            if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string")) {
                throw new LocalSessionError("invalid_answer", "The default choices are invalid");
            }
            return values;
        }
        case "select":
        case "string":
            return field.defaultStringValue;
    }
}

/** One terminal view of a daemon-owned session. Disconnecting this view never cancels its turn. */
export async function runTerminalSession(
    connection: LocalSessionConnection,
    options: { readonly prompt?: string; readonly json?: boolean },
    signal: AbortSignal,
): Promise<void> {
    let state: TerminalState =
        connection.session.status.kind === "working"
            ? { kind: "working", commandId: connection.session.status.commandId }
            : { kind: "idle" };
    const write = (text: string): void => {
        if (options.json !== true) {
            process.stdout.write(stripVTControlCharacters(text));
        }
    };
    const commandId = options.prompt === undefined ? null : randomUUID();
    const completion = Promise.withResolvers<void>();
    let completed = false;
    const finish = (error?: unknown): void => {
        if (completed) {
            return;
        }
        completed = true;
        if (error === undefined) {
            completion.resolve();
        } else {
            completion.reject(error);
        }
    };
    const prompt = (text: string, id = randomUUID()): void => {
        state = { kind: "working", commandId: id };
        connection.send({
            kind: "session.prompt",
            commandId: id,
            sessionId: connection.session.sessionId,
            agentId: connection.session.agentId,
            bindingId: connection.bindingId,
            directoryId: connection.session.directoryId,
            additionalDirectoryIds: connection.session.additionalDirectories.map((entry) => entry.directoryId),
            disposition: SessionPromptDisposition.Reject,
            targetCommandId: "",
            prompt: text,
            images: [],
            resources: [],
        });
    };
    const showField = (): void => {
        if (state.kind !== "answering") {
            return;
        }
        const field = state.request.fields[state.index];
        if (field === undefined) {
            const request = state.request;
            connection.send({
                kind: "session.elicitation.respond",
                sessionId: request.sessionId,
                interactionId: request.interactionId,
                action: "accept",
                content: JSON.stringify(state.answers),
            });
            state = {
                kind: "submitted",
                commandId: request.commandId,
                interactionId: request.interactionId,
                previous: state,
            };
            write("Answer submitted.\n");
            return;
        }
        write(`\n${field.title}\n${field.description.length > 0 ? `${field.description}\n` : ""}`);
        field.options.forEach((option, index) => {
            write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`);
        });
        if (field.hasDefaultValue) {
            write(`Current value:\n${String(defaultAnswer(field))}\nUse /keep to keep it.\n`);
        }
        if (!field.required) {
            write("Use /skip to omit this field.\n");
        }
        write(
            field.multiline === true
                ? "Enter lines, then /end to submit this field.\n"
                : field.type === "multiselect"
                  ? "Enter option numbers separated by commas: "
                  : "Answer: ",
        );
    };
    const showQuestion = (request: Question): void => {
        write("\nAnswer here or in Morty. The first accepted answer continues this session.\n");
        if (request.kind === "session.permission.requested") {
            state = { kind: "permission", request };
            write(`${request.title}\n`);
            request.options.forEach((option, index) => {
                write(`  ${index + 1}. ${option.name}\n`);
            });
            write("Choose an option number, or /cancel: ");
        } else if (request.mode === "url") {
            state = { kind: "working", commandId: request.commandId };
            write(`${request.message}\nComplete this request in Morty: ${request.url}\n`);
        } else {
            state = { kind: "answering", request, index: 0, answers: {}, lines: [] };
            write(`${request.message}\n`);
            showField();
        }
    };
    const acceptField = (field: SessionElicitationField, line: string): Answer | undefined => {
        if (field.type === "select" || field.type === "multiselect") {
            if (line.length === 0 && !field.required) {
                return field.type === "multiselect" ? [] : undefined;
            }
            const selections = line.split(",").map((entry) => {
                const index = Number(entry.trim()) - 1;
                return Number.isInteger(index) ? field.options[index]?.value : undefined;
            });
            if (
                selections.some((entry) => entry === undefined) ||
                (field.type === "select" && selections.length !== 1)
            ) {
                throw new LocalSessionError("invalid_answer", "Choose a listed option number");
            }
            return field.type === "select"
                ? selections[0]
                : selections.filter((entry): entry is string => entry !== undefined);
        }
        if (field.type === "boolean") {
            if (/^(y|yes|true)$/iu.test(line)) {
                return true;
            }
            if (/^(n|no|false)$/iu.test(line)) {
                return false;
            }
            throw new LocalSessionError("invalid_answer", "Enter yes or no");
        }
        if (field.type === "number" || field.type === "integer") {
            const number = Number(line);
            if (
                line.length === 0 ||
                !Number.isFinite(number) ||
                (field.type === "integer" && !Number.isInteger(number))
            ) {
                throw new LocalSessionError("invalid_answer", "Enter a valid number");
            }
            return number;
        }
        return line;
    };
    const onLine = (line: string): void => {
        try {
            if (line === "/exit") {
                finish();
                return;
            }
            if (line === "/stop" && state.kind !== "idle") {
                const id =
                    state.kind === "permission" || state.kind === "answering"
                        ? state.request.commandId
                        : state.commandId;
                connection.send({ kind: "session.cancel", sessionId: connection.session.sessionId, commandId: id });
                return;
            }
            if (state.kind === "permission") {
                const request = state.request;
                const option = request.options[Number(line) - 1];
                if (line !== "/cancel" && option === undefined) {
                    write("Choose a listed option number: ");
                    return;
                }
                connection.send({
                    kind: "session.permission.respond",
                    sessionId: request.sessionId,
                    interactionId: request.interactionId,
                    outcome: option === undefined ? "cancelled" : "selected",
                    optionId: option?.optionId ?? "",
                });
                state = {
                    kind: "submitted",
                    commandId: request.commandId,
                    interactionId: request.interactionId,
                    previous: state,
                };
            } else if (state.kind === "answering") {
                const current = state;
                if (line === "/cancel") {
                    connection.send({
                        kind: "session.elicitation.respond",
                        sessionId: current.request.sessionId,
                        interactionId: current.request.interactionId,
                        action: "cancel",
                        content: "",
                    });
                    state = {
                        kind: "submitted",
                        commandId: current.request.commandId,
                        interactionId: current.request.interactionId,
                        previous: current,
                    };
                    return;
                }
                const field = current.request.fields[current.index];
                if (field === undefined) {
                    return;
                }
                if (line === "/skip" && field.required) {
                    throw new LocalSessionError("invalid_answer", "This field is required");
                }
                if (field.multiline === true && line !== "/end" && line !== "/keep" && line !== "/skip") {
                    state = { ...current, lines: [...current.lines, line] };
                    return;
                }
                const value =
                    line === "/skip"
                        ? undefined
                        : line === "/keep" && field.hasDefaultValue
                          ? defaultAnswer(field)
                          : acceptField(field, field.multiline === true ? current.lines.join("\n") : line);
                state = {
                    ...current,
                    index: current.index + 1,
                    lines: [],
                    answers: value === undefined ? current.answers : { ...current.answers, [field.name]: value },
                };
                showField();
            } else if (state.kind === "idle" && line.trim().length > 0) {
                prompt(line);
            } else {
                write("The agent is working. Use /stop to stop the turn, or /exit to disconnect.\n");
            }
        } catch (cause) {
            write(`${cause instanceof Error ? cause.message : "The answer could not be sent"}\n`);
            showField();
        }
    };
    const applyEvent = (event: SessionLiveEvent): void => {
        if (event.type === "acp") {
            if (
                (event.payload.sessionUpdate === "agent_message_chunk" ||
                    event.payload.sessionUpdate === "agent_thought_chunk") &&
                event.payload.content.type === "text"
            ) {
                write(event.payload.content.text);
            }
            return;
        }
        if (event.type !== "lifecycle-metadata") {
            return;
        }
        const payload = event.payload;
        if (payload.kind === "prompt.started") {
            if (state.kind === "idle") {
                state = { kind: "working", commandId: payload.commandId };
            }
        } else if (
            payload.kind === "session.elicitation.requested" ||
            payload.kind === "session.permission.requested"
        ) {
            showQuestion(payload.event);
        } else if (payload.kind === "session.elicitation.resolved" || payload.kind === "session.permission.resolved") {
            const id =
                state.kind === "answering" || state.kind === "permission"
                    ? state.request.interactionId
                    : state.kind === "submitted"
                      ? state.interactionId
                      : null;
            if (id === payload.event.interactionId && state.kind !== "idle") {
                const active =
                    state.kind === "answering" || state.kind === "permission"
                        ? state.request.commandId
                        : state.commandId;
                state = { kind: "working", commandId: active };
                write("\nAnswer received. Continuing…\n");
            }
        } else if (payload.kind === "prompt.completed") {
            state = { kind: "idle" };
            write("\n\nYou: ");
            if (payload.commandId === commandId) {
                finish();
            }
        } else if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
            state = { kind: "idle" };
            write("\nThe agent could not complete this turn. See Morty for details.\nYou: ");
            if (payload.commandId === commandId) {
                finish(new LocalSessionError("local_session_turn_failed", "The agent could not complete this turn"));
            }
        }
    };
    write(
        `Connected to ${connection.session.title} (${connection.session.agentId}).\nThis terminal and Morty share the same session. /stop stops a turn; /exit disconnects.\n`,
    );
    const input =
        options.prompt === undefined
            ? createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
            : null;
    input?.on("line", onLine);
    input?.once("close", () => finish());
    const abort = (): void => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const operationFailed = (requestId: string, code: string, message: string): void => {
        write(`\n${message}\n`);
        if (requestId === commandId) {
            finish(new LocalSessionError(code, message));
        }
        if (state.kind === "submitted" && state.interactionId === requestId) {
            const previous = state.previous;
            showQuestion(previous.request);
        } else if (state.kind === "working" && state.commandId === requestId) {
            state = { kind: "idle" };
            write("You: ");
        }
    };
    const receive = (async () => {
        try {
            for await (const message of connection.messages) {
                if (options.json === true) {
                    process.stdout.write(`${JSON.stringify(message)}\n`);
                }
                if (message.kind === SESSION_EVENT_KIND) {
                    message.events.forEach(applyEvent);
                } else if (
                    message.kind === "native.session.result" &&
                    message.action === "active-turn" &&
                    message.turn?.interaction != null
                ) {
                    showQuestion(message.turn.interaction);
                } else if (message.kind === "session.operation.failed") {
                    operationFailed(message.requestId, message.code, message.message);
                }
            }
            if (!completed) {
                finish(
                    new LocalSessionError(
                        "local_session_disconnected",
                        "The terminal disconnected; reconnect to continue viewing this session",
                    ),
                );
            }
        } catch (cause) {
            if (!completed) {
                finish(cause);
            }
        }
    })();
    try {
        signal.throwIfAborted();
        if (options.prompt !== undefined && commandId !== null) {
            prompt(options.prompt, commandId);
        } else if (state.kind === "idle") {
            write("You: ");
        }
        await completion.promise;
    } finally {
        signal.removeEventListener("abort", abort);
        input?.close();
        connection.close();
        await receive;
    }
}
