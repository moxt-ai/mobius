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

interface GeminiTool {
    readonly name: string;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionResponseCount(value: unknown): number {
    return countMatchingObjects(value, (object) => isObject(object["functionResponse"]));
}

function availableTools(payload: JsonObject): readonly GeminiTool[] {
    if (!Array.isArray(payload["tools"])) {
        return [];
    }
    return payload["tools"].flatMap((group) => {
        if (!isObject(group) || !Array.isArray(group["functionDeclarations"])) {
            return [];
        }
        return group["functionDeclarations"].flatMap((declaration) =>
            isObject(declaration) && typeof declaration["name"] === "string" ? [{ name: declaration["name"] }] : [],
        );
    });
}

function sendEvent(response: ServerResponse, parts: readonly JsonObject[]): void {
    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    });
    response.end(
        `data: ${JSON.stringify({
            candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }],
            modelVersion: "gemini-2.5-flash",
            responseId: "response-mobius",
            usageMetadata: { candidatesTokenCount: 6, promptTokenCount: 10, totalTokenCount: 16 },
        })}\n\n`,
    );
}

export class FakeGeminiProvider implements AsyncDisposable {
    static readonly apiKey = "mobius-agent-daemon-fixture";

    readonly origin: string;
    readonly response: string;
    readonly #answer: string;
    readonly #close: () => Promise<void>;

    private constructor(origin: string, answer: string, close: () => Promise<void>) {
        this.#answer = answer;
        this.origin = origin;
        this.response = fakeProviderResponse(
            answer,
            selectFakeProviderScenario({ input: fakeProviderPrompts.successfulTool }),
        );
        this.#close = close;
    }

    responseFor(prompt: string): string {
        return fakeProviderResponse(this.#answer, selectFakeProviderScenario({ input: prompt }));
    }

    static async start(answer: string): Promise<FakeGeminiProvider> {
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const decoded: unknown = body.length === 0 ? {} : JSON.parse(body);
            const payload = isObject(decoded) ? decoded : {};
            const scenario: FakeProviderScenario = selectFakeProviderScenario(payload);
            const completedToolCalls = functionResponseCount(payload);
            const list = availableTools(payload).find((tool) => /(?:^|_)list_directory$/iu.test(tool.name));
            if (completedToolCalls < scenario.toolCalls && list !== undefined) {
                sendEvent(response, [
                    {
                        functionCall: {
                            args: { dir_path: scenario.command === "false" ? "./mobius-missing-directory" : "." },
                            id: `call_mobius_${(completedToolCalls + 1).toString()}`,
                            name: list.name,
                        },
                    },
                ]);
                return;
            }
            const selectedAnswer = fakeProviderResponse(answer, scenario);
            sendEvent(
                response,
                responseChunks(selectedAnswer, scenario).map((text) => ({ text })),
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake Gemini provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        };
        return new FakeGeminiProvider(`http://127.0.0.1:${address.port.toString()}`, answer, close);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
