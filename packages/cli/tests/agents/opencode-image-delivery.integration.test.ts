import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { OpenCodeAgentSpecification } from "../../src/agent-catalog/agents/opencode-agent.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { OpenCodeFixture } from "../support/agents/opencode.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { verifyImageDelivery } from "../support/agents/verify-image-delivery.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const side of [128]) {
    test(`Given real OpenCode reads a ${side}px image, When its reply streams and native history reopens, Then clients retrieve identical bytes without base64 fragments and can continue chatting`, async () => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "IMAGE_REPLY", { readPath: "picture.png" });
        await using agent = await OpenCodeFixture.create(provider);
        await withRealDaemon(new OpenCodeAgentSpecification(), agent.environment, async (peer) => {
            const image = imageFixture(side);
            await writeFile(join(peer.workspace, "picture.png"), image);
            await verifyImageDelivery(peer, {
                agentId: "opencode",
                image,
                reference: `mobius-content:image:${createHash("sha256").update(image).digest("hex")}`,
                prompt: "Use the read tool to inspect picture.png, then reply",
            });
        });
    });
}
