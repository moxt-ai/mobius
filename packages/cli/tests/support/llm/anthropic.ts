import { createServer, type ServerResponse } from "node:http";

import {
    countMatchingObjects,
    type FakeProviderScenario,
    fakeProviderPrompts,
    fakeProviderResponse,
    responseChunks,
    selectFakeProviderScenario,
} from "./scenarios.ts";

type JsonObject = Record<string, unknown>;

interface AnthropicTool {
    readonly inputSchema: JsonObject;
    readonly name: string;
}

interface ProviderRequestDiagnostic {
    readonly scenario: FakeProviderScenario;
    readonly selectedTool: string | undefined;
    readonly toolResultCount: number;
    readonly tools: readonly string[];
    readonly url: string;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultCount(value: unknown): number {
    return countMatchingObjects(value, (object) => object["type"] === "tool_result");
}

function availableTools(payload: JsonObject): readonly AnthropicTool[] {
    if (!Array.isArray(payload["tools"])) {
        return [];
    }
    return payload["tools"].flatMap((tool) => {
        if (!isObject(tool) || typeof tool["name"] !== "string" || !isObject(tool["input_schema"])) {
            return [];
        }
        return [{ inputSchema: tool["input_schema"], name: tool["name"] }];
    });
}

function stringProperty(tool: AnthropicTool, candidates: readonly string[]): string | undefined {
    const properties = tool.inputSchema["properties"];
    if (!isObject(properties)) {
        return undefined;
    }
    return candidates.find((candidate) => isObject(properties[candidate]));
}

function selectTool(
    tools: readonly AnthropicTool[],
    scenario: FakeProviderScenario,
    completedToolCalls: number,
): { readonly id: string; readonly input: JsonObject; readonly name: string } | undefined {
    const id = `toolu_mobius_${(completedToolCalls + 1).toString()}`;
    const shell = tools.find((tool) => /(?:^|_)(?:bash|shell|command)$/iu.test(tool.name));
    if (shell !== undefined) {
        const command = stringProperty(shell, ["command", "cmd"]);
        if (command !== undefined) {
            return { id, input: { [command]: scenario.command }, name: shell.name };
        }
    }
    const read = tools.find((tool) => /(?:^|_)(?:read|read_file)$/iu.test(tool.name));
    if (read !== undefined) {
        const path = stringProperty(read, ["file_path", "filePath", "path", "file"]);
        if (path !== undefined) {
            return {
                id,
                input: { [path]: scenario.command === "false" ? "./mobius-missing-file" : "." },
                name: read.name,
            };
        }
    }
    return undefined;
}

function message(model: string, content: readonly JsonObject[], stopReason: "end_turn" | "tool_use"): JsonObject {
    return {
        id: "msg_mobius",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 6 },
    };
}

function event(response: ServerResponse, type: string, payload: JsonObject): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendStream(
    response: ServerResponse,
    model: string,
    content: JsonObject,
    chunks: readonly string[],
    stopReason: "end_turn" | "tool_use",
): void {
    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    });
    event(response, "message_start", {
        message: {
            ...message(model, [], stopReason),
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
        },
    });
    event(response, "content_block_start", {
        index: 0,
        content_block: content["type"] === "tool_use" ? { ...content, input: {} } : { type: "text", text: "" },
    });
    if (content["type"] === "tool_use") {
        event(response, "content_block_delta", {
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content["input"]) },
        });
    } else {
        for (const chunk of chunks) {
            event(response, "content_block_delta", {
                index: 0,
                delta: { type: "text_delta", text: chunk },
            });
        }
    }
    event(response, "content_block_stop", { index: 0 });
    event(response, "message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 6 },
    });
    event(response, "message_stop", {});
    response.end();
}

export class FakeAnthropicProvider implements AsyncDisposable {
    static readonly apiKey = "mobius-agent-daemon-fixture";

    readonly model: string;
    readonly origin: string;
    readonly response: string;
    readonly #answer: string;
    readonly #close: () => Promise<void>;
    readonly #requests: ProviderRequestDiagnostic[];

    private constructor(
        origin: string,
        model: string,
        answer: string,
        requests: ProviderRequestDiagnostic[],
        close: () => Promise<void>,
    ) {
        this.origin = origin;
        this.model = model;
        this.#answer = answer;
        this.response = fakeProviderResponse(
            answer,
            selectFakeProviderScenario({ input: fakeProviderPrompts.successfulTool }),
        );
        this.#requests = requests;
        this.#close = close;
    }

    diagnostics(): readonly ProviderRequestDiagnostic[] {
        return this.#requests;
    }

    responseFor(prompt: string): string {
        return fakeProviderResponse(this.#answer, selectFakeProviderScenario({ input: prompt }));
    }

    static async start(
        model: string,
        answer: string,
        options: { readonly beforeFirstText?: () => Promise<void>; readonly disconnectsBeforeSuccess?: number } = {},
    ): Promise<FakeAnthropicProvider> {
        const requests: ProviderRequestDiagnostic[] = [];
        let disconnectsRemaining = options.disconnectsBeforeSuccess ?? 0;
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const decoded: unknown = body.length === 0 ? {} : JSON.parse(body);
            const payload = isObject(decoded) ? decoded : {};
            if (request.url?.endsWith("/messages/count_tokens") === true) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ input_tokens: 10 }));
                return;
            }
            if (disconnectsRemaining > 0) {
                disconnectsRemaining -= 1;
                response.destroy();
                return;
            }

            const tools = availableTools(payload);
            const scenario = selectFakeProviderScenario(payload);
            const completedToolCalls = toolResultCount(payload);
            const tool =
                completedToolCalls < scenario.toolCalls ? selectTool(tools, scenario, completedToolCalls) : undefined;
            const selectedAnswer = fakeProviderResponse(answer, scenario);
            requests.push({
                scenario,
                selectedTool: tool?.name,
                toolResultCount: completedToolCalls,
                tools: tools.map(({ name }) => name),
                url: request.url ?? "",
            });
            const content =
                tool === undefined
                    ? { type: "text", text: selectedAnswer }
                    : { type: "tool_use", id: tool.id, name: tool.name, input: tool.input };
            const stopReason = tool === undefined ? "end_turn" : "tool_use";
            if (tool === undefined) {
                await options.beforeFirstText?.();
            }
            if (payload["stream"] === true) {
                sendStream(response, model, content, responseChunks(selectedAnswer, scenario), stopReason);
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(message(model, [content], stopReason)));
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake Anthropic provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        };
        return new FakeAnthropicProvider(`http://127.0.0.1:${address.port.toString()}`, model, answer, requests, close);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
