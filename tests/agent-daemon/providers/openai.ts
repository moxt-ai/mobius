import { createServer, type ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

interface AvailableTool {
    readonly kind: "custom" | "function";
    readonly name: string;
    readonly parameters: JsonObject | undefined;
}

interface SelectedTool extends AvailableTool {
    readonly input: string;
}

interface ProviderRequestDiagnostic {
    readonly hasToolResult: boolean;
    readonly selectedTool: Readonly<Pick<SelectedTool, "kind" | "name">> | undefined;
    readonly tools: readonly Readonly<Pick<AvailableTool, "kind" | "name">>[];
    readonly url: string;
}

const toolCallId = "call_mobius";

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTool(value: unknown, namespace = ""): readonly AvailableTool[] {
    if (!isObject(value)) {
        return [];
    }
    if (value["type"] === "namespace" && typeof value["name"] === "string" && Array.isArray(value["tools"])) {
        const prefix = namespace.length === 0 ? value["name"] : `${namespace}.${value["name"]}`;
        return value["tools"].flatMap((tool) => collectTool(tool, prefix));
    }
    const definition = isObject(value["function"]) ? value["function"] : value;
    const name = definition["name"];
    if (typeof name !== "string") {
        return [];
    }
    const qualifiedName = namespace.length === 0 ? name : `${namespace}.${name}`;
    return [
        {
            kind: value["type"] === "custom" ? "custom" : "function",
            name: qualifiedName,
            parameters: isObject(definition["parameters"]) ? definition["parameters"] : undefined,
        },
    ];
}

function availableTools(payload: JsonObject): readonly AvailableTool[] {
    const direct = Array.isArray(payload["tools"]) ? payload["tools"].flatMap((tool) => collectTool(tool)) : [];
    const input = Array.isArray(payload["input"]) ? payload["input"] : [];
    const additional = input.flatMap((item) => {
        if (!isObject(item) || item["type"] !== "additional_tools" || !Array.isArray(item["tools"])) {
            return [];
        }
        return item["tools"].flatMap((tool) => collectTool(tool));
    });
    return [...direct, ...additional];
}

function includesToolResult(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(includesToolResult);
    }
    if (!isObject(value)) {
        return false;
    }
    const type = value["type"];
    if (
        value["role"] === "tool" ||
        type === "tool_result" ||
        type === "function_call_output" ||
        type === "custom_tool_call_output"
    ) {
        return true;
    }
    return Object.values(value).some(includesToolResult);
}

function stringProperty(parameters: JsonObject | undefined, candidates: readonly string[]): string | undefined {
    const properties = parameters?.["properties"];
    if (!isObject(properties)) {
        return undefined;
    }
    return candidates.find((candidate) => isObject(properties[candidate]));
}

function selectTool(tools: readonly AvailableTool[]): SelectedTool | undefined {
    const shell = tools.find((tool) => /(?:^|\.)(?:exec|bash|shell|command)$/iu.test(tool.name));
    if (shell !== undefined) {
        if (shell.kind === "custom") {
            return {
                kind: "custom",
                name: shell.name.slice(shell.name.lastIndexOf(".") + 1),
                parameters: undefined,
                input: 'const result = await tools.exec_command({ cmd: "pwd", max_output_tokens: 1000 });\ntext(result.output);',
            };
        }
        const command = stringProperty(shell.parameters, ["command", "cmd"]);
        if (command !== undefined) {
            return { ...shell, input: JSON.stringify({ [command]: "pwd" }) };
        }
    }

    const read = tools.find((tool) => /(?:^|\.)(?:read|read_file)$/iu.test(tool.name));
    if (read !== undefined && read.kind === "function") {
        const path = stringProperty(read.parameters, ["filePath", "path", "file"]);
        if (path !== undefined) {
            return { ...read, input: JSON.stringify({ [path]: "." }) };
        }
    }
    return undefined;
}

function responseHeaders(): Readonly<Record<string, string>> {
    return {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    };
}

function completedResponse(model: string, output: readonly JsonObject[]): JsonObject {
    return {
        id: "resp_mobius",
        object: "response",
        created_at: 0,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model,
        output,
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: null,
        text: { format: { type: "text" }, verbosity: "medium" },
        tool_choice: "auto",
        tools: [],
        top_p: null,
        truncation: "disabled",
        usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 6,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 16,
        },
        user: null,
        metadata: {},
    };
}

function responsesEvent(response: ServerResponse, type: string, payload: JsonObject): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendResponsesText(response: ServerResponse, model: string, answer: string): void {
    const item = {
        id: "msg_mobius",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }],
    };
    const completed = completedResponse(model, [item]);
    responsesEvent(response, "response.created", { response: { ...completed, status: "in_progress", output: [] } });
    responsesEvent(response, "response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
    responsesEvent(response, "response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
    });
    responsesEvent(response, "response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
    });
    responsesEvent(response, "response.output_text.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: answer,
    });
    responsesEvent(response, "response.content_part.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
    });
    responsesEvent(response, "response.output_item.done", { output_index: 0, item });
    responsesEvent(response, "response.completed", { response: completed });
    response.end();
}

function sendResponsesToolCall(response: ServerResponse, model: string, tool: SelectedTool): void {
    const type = tool.kind === "custom" ? "custom_tool_call" : "function_call";
    const item = {
        id: "tool_mobius",
        type,
        call_id: toolCallId,
        name: tool.name,
        status: "completed",
        ...(tool.kind === "custom" ? { input: tool.input } : { arguments: tool.input }),
    };
    const completed = completedResponse(model, [item]);
    responsesEvent(response, "response.created", { response: { ...completed, status: "in_progress", output: [] } });
    responsesEvent(response, "response.output_item.added", {
        output_index: 0,
        item: { ...item, ...(tool.kind === "custom" ? { input: "" } : { arguments: "" }) },
    });
    if (tool.kind === "custom") {
        responsesEvent(response, "response.custom_tool_call_input.delta", {
            item_id: item.id,
            output_index: 0,
            delta: tool.input,
        });
        responsesEvent(response, "response.custom_tool_call_input.done", {
            item_id: item.id,
            output_index: 0,
            input: tool.input,
        });
    } else {
        responsesEvent(response, "response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: 0,
            delta: tool.input,
        });
        responsesEvent(response, "response.function_call_arguments.done", {
            item_id: item.id,
            output_index: 0,
            arguments: tool.input,
        });
    }
    responsesEvent(response, "response.output_item.done", { output_index: 0, item });
    responsesEvent(response, "response.completed", { response: completed });
    response.end();
}

function chatChunk(response: ServerResponse, model: string, choices: unknown, usage?: unknown): void {
    response.write(
        `data: ${JSON.stringify({
            id: "chatcmpl-mobius",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices,
            ...(usage === undefined ? {} : { usage }),
        })}\n\n`,
    );
}

function sendChatText(response: ServerResponse, model: string, answer: string): void {
    chatChunk(response, model, [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }]);
    chatChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }], {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16,
    });
    response.end("data: [DONE]\n\n");
}

function sendChatToolCall(response: ServerResponse, model: string, tool: SelectedTool): void {
    chatChunk(response, model, [
        {
            index: 0,
            delta: {
                role: "assistant",
                tool_calls: [
                    {
                        index: 0,
                        id: toolCallId,
                        type: "function",
                        function: { name: tool.name, arguments: tool.input },
                    },
                ],
            },
            finish_reason: null,
        },
    ]);
    chatChunk(response, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16,
    });
    response.end("data: [DONE]\n\n");
}

export class FakeOpenAiProvider implements AsyncDisposable {
    static readonly apiKey = "mobius-agent-daemon-fixture";

    readonly model: string;
    readonly origin: string;
    readonly response: string;
    readonly #close: () => Promise<void>;
    readonly #requests: ProviderRequestDiagnostic[];

    private constructor(
        origin: string,
        model: string,
        response: string,
        requests: ProviderRequestDiagnostic[],
        close: () => Promise<void>,
    ) {
        this.model = model;
        this.origin = origin;
        this.response = response;
        this.#requests = requests;
        this.#close = close;
    }

    diagnostics(): readonly ProviderRequestDiagnostic[] {
        return this.#requests;
    }

    static async start(model: string, answer: string): Promise<FakeOpenAiProvider> {
        const requests: ProviderRequestDiagnostic[] = [];
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const decoded: unknown = JSON.parse(body);
            const payload = isObject(decoded) ? decoded : {};
            const tools = availableTools(payload);
            const hasToolResult = includesToolResult(payload);
            const tool = hasToolResult ? undefined : selectTool(tools);
            requests.push({
                hasToolResult,
                selectedTool: tool === undefined ? undefined : { kind: tool.kind, name: tool.name },
                tools: tools.map(({ kind, name }) => ({ kind, name })),
                url: request.url ?? "",
            });

            response.writeHead(200, responseHeaders());
            if (request.url?.endsWith("/responses") === true) {
                if (tool === undefined) {
                    sendResponsesText(response, model, answer);
                } else {
                    sendResponsesToolCall(response, model, tool);
                }
                return;
            }
            if (tool === undefined) {
                sendChatText(response, model, answer);
            } else {
                sendChatToolCall(response, model, tool);
            }
        });
        server.on("upgrade", (_request, socket) => {
            socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake OpenAI provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        };
        return new FakeOpenAiProvider(`http://127.0.0.1:${address.port.toString()}`, model, answer, requests, close);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
