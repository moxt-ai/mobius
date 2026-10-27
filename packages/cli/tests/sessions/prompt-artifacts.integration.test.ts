import { createHash } from "node:crypto";
import { PROMPT_IMAGE_MAX_BYTES, type PromptAttachment } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { type PromptArtifactError, resolvePromptArtifacts } from "../../src/session/prompt/prompt-artifacts.ts";

function imageAttachment(bytes: Uint8Array): PromptAttachment {
    return {
        byteLength: bytes.byteLength,
        contentKey: createHash("sha256").update(bytes).digest("hex"),
        kind: "image",
        mimeType: "image/png",
        name: "large-image.png",
        uri: "attachment:///large-image.png",
    };
}

test("Given an image above the former Base64 limit, When prompt artifacts resolve, Then the original bytes are accepted", async () => {
    const bytes = new Uint8Array(3_100_000);
    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve(bytes),
        [imageAttachment(bytes)],
        new AbortController().signal,
    );

    expect(artifacts.images).toHaveLength(1);
    expect(Buffer.from(artifacts.images[0]?.data ?? "", "base64").byteLength).toBe(bytes.byteLength);
});

test("Given an image above the shared prompt limit, When prompt artifacts resolve, Then it is rejected before Base64 encoding", async () => {
    const bytes = new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 1);

    await expect(
        resolvePromptArtifacts(() => Promise.resolve(bytes), [imageAttachment(bytes)], new AbortController().signal),
    ).rejects.toMatchObject({ code: "artifact_too_large_for_agent" } satisfies Partial<PromptArtifactError>);
});
