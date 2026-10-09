import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";

const file = process.argv[2];
if (file === undefined) {
    throw new Error("An image fixture path is required");
}
const data = (await readFile(file)).toString("base64");
const requestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
});
for await (const line of createInterface({ input: process.stdin })) {
    const unknownRequest: unknown = JSON.parse(line);
    const request = requestSchema.parse(unknownRequest);
    if (request.id === undefined) {
        continue;
    }
    let result: unknown;
    switch (request.method) {
        case "initialize":
            result = {
                protocolVersion: request.params?.["protocolVersion"],
                capabilities: { tools: {} },
                serverInfo: { name: "image-test", version: "1" },
            };
            break;
        case "tools/list":
            result = {
                tools: [
                    {
                        name: "image",
                        description: "Return the configured PNG",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            };
            break;
        case "tools/call":
            result = { content: [{ type: "image", data, mimeType: "image/png" }] };
            break;
        default:
            result = {};
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
