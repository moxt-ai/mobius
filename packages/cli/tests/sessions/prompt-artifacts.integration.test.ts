import { createHash } from "node:crypto";
import { PROMPT_IMAGE_MAX_BYTES, type PromptAttachment } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { resolvePromptArtifacts } from "../../src/engine/session/prompt/prompt-artifacts.ts";

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

test("Given an image above the shared prompt limit, When prompt artifacts resolve, Then it is skipped before Base64 encoding", async () => {
    const bytes = new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 1);

    const result = await resolvePromptArtifacts(
        () => Promise.resolve(bytes),
        [imageAttachment(bytes)],
        new AbortController().signal,
    );
    expect(result.images).toEqual([]);
    expect(result.skipped).toEqual(['"large-image.png" (image limit exceeded)']);
});

test("Given an unsupported attachment with invalid integrity, When resolving the prompt, Then corruption is rejected instead of downgraded", async () => {
    const bytes = new TextEncoder().encode("original PDF");
    const attachment: PromptAttachment = {
        ...imageAttachment(bytes),
        kind: "resource",
        mimeType: "application/pdf",
        name: "document.pdf",
    };
    await expect(
        resolvePromptArtifacts(
            () => Promise.resolve(new Uint8Array(bytes.length)),
            [attachment],
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "artifact_integrity_failed" });
});
