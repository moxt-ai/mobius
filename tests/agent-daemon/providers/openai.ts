import { createServer } from "node:http";

export class FakeOpenAiProvider implements AsyncDisposable {
    static readonly apiKey = "mobius-agent-daemon-fixture";
    static readonly model = "mobius-test-model";
    static readonly response = "Response from the local fake provider";

    readonly origin: string;
    readonly #close: () => Promise<void>;

    private constructor(origin: string, close: () => Promise<void>) {
        this.origin = origin;
        this.#close = close;
    }

    static async start(): Promise<FakeOpenAiProvider> {
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Consume the body so the real agent can reuse the connection.
            }
            response.writeHead(200, {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "content-type": "text/event-stream",
            });
            const chunk = (choices: unknown, usage?: unknown): void => {
                response.write(
                    `data: ${JSON.stringify({
                        id: "chatcmpl-mobius",
                        object: "chat.completion.chunk",
                        created: 0,
                        model: FakeOpenAiProvider.model,
                        choices,
                        ...(usage === undefined ? {} : { usage }),
                    })}\n\n`,
                );
            };
            chunk([
                {
                    index: 0,
                    delta: { role: "assistant", content: FakeOpenAiProvider.response },
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
        return new FakeOpenAiProvider(`http://127.0.0.1:${address.port.toString()}`, close);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
