import { createServer } from "node:http";

export class FakeOpenAiProvider implements AsyncDisposable {
    static readonly apiKey = "mobius-agent-daemon-fixture";

    readonly model: string;
    readonly origin: string;
    readonly response: string;
    readonly #close: () => Promise<void>;

    private constructor(origin: string, model: string, response: string, close: () => Promise<void>) {
        this.model = model;
        this.origin = origin;
        this.response = response;
        this.#close = close;
    }

    static async start(model: string, answer: string): Promise<FakeOpenAiProvider> {
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Consume the body so the real agent can reuse the connection.
            }
            const headers = {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "content-type": "text/event-stream",
            };
            if (request.url?.endsWith("/responses") === true) {
                response.writeHead(200, headers);
                const item = {
                    id: "msg_mobius",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: answer, annotations: [] }],
                };
                const completed = {
                    id: "resp_mobius",
                    object: "response",
                    created_at: 0,
                    status: "completed",
                    error: null,
                    incomplete_details: null,
                    instructions: null,
                    max_output_tokens: null,
                    model,
                    output: [item],
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
                const event = (type: string, payload: Readonly<Record<string, unknown>>): void => {
                    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
                };
                event("response.created", { response: { ...completed, status: "in_progress", output: [] } });
                event("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
                event("response.content_part.added", {
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                });
                event("response.output_text.delta", {
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    delta: answer,
                });
                event("response.output_text.done", {
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    text: answer,
                });
                event("response.content_part.done", {
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    part: item.content[0],
                });
                event("response.output_item.done", { output_index: 0, item });
                event("response.completed", { response: completed });
                response.end();
                return;
            }

            response.writeHead(200, headers);
            const chunk = (choices: unknown, usage?: unknown): void => {
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
            };
            chunk([
                {
                    index: 0,
                    delta: { role: "assistant", content: answer },
                    finish_reason: null,
                },
            ]);
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
                prompt_tokens: 10,
                completion_tokens: 6,
                total_tokens: 16,
            });
            response.end("data: [DONE]\n\n");
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
        return new FakeOpenAiProvider(`http://127.0.0.1:${address.port.toString()}`, model, answer, close);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
