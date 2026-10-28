import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PROMPT_IMAGE_MAX_BYTES,
    PROMPT_TEXT_RESOURCE_MAX_BYTES,
    type PromptAttachment,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { buildPromptContent } from "../../src/acp/client/prompt-content.ts";
import { unsupportedSessionCapabilities } from "../../src/acp/protocol/session-capabilities.ts";
import { type PromptArtifactError, resolvePromptArtifacts } from "../../src/session/prompt/prompt-artifacts.ts";
import { exposePromptDocuments } from "../../src/session/prompt/prompt-documents.ts";

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

function attachment(
    bytes: Uint8Array,
    kind: PromptAttachment["kind"],
    mimeType: string,
    name: string,
): PromptAttachment {
    return {
        byteLength: bytes.byteLength,
        contentKey: createHash("sha256").update(bytes).digest("hex"),
        kind,
        mimeType,
        name,
        uri: `attachment:///${name}`,
    };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

test("Given an SVG prompt image, When the prompt is built, Then the chat keeps the SVG as an image", async () => {
    const bytes = new TextEncoder().encode(svg);
    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve(bytes),
        [attachment(bytes, "image", "image/svg+xml", "diagram.svg")],
        new AbortController().signal,
    );
    const blocks = buildPromptContent(
        { images: artifacts.images, prompt: "Explain this drawing", resources: artifacts.resources },
        { ...unsupportedSessionCapabilities(), embeddedContextPrompt: true, imagePrompt: true },
    );

    expect(blocks).toContainEqual({
        _meta: { mobius: { name: "diagram.svg" } },
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "image/svg+xml",
        type: "image",
    });
});

test("Given an SVG prompt image and an agent without embedded context, When the prompt is built, Then the SVG stays an image", async () => {
    const bytes = new TextEncoder().encode(svg);
    const artifacts = await resolvePromptArtifacts(
        () => Promise.resolve(bytes),
        [attachment(bytes, "image", "image/svg+xml", "diagram.svg")],
        new AbortController().signal,
    );
    const blocks = buildPromptContent(
        { images: artifacts.images, prompt: "", resources: [] },
        { ...unsupportedSessionCapabilities(), imagePrompt: true },
    );

    expect(blocks).toContainEqual({
        _meta: { mobius: { name: "diagram.svg" } },
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "image/svg+xml",
        type: "image",
    });
});

test("Given an SVG larger than the text resource limit, When artifacts resolve, Then it is rejected", async () => {
    const bytes = new Uint8Array(PROMPT_TEXT_RESOURCE_MAX_BYTES + 1);

    await expect(
        resolvePromptArtifacts(
            () => Promise.resolve(bytes),
            [attachment(bytes, "image", "image/svg+xml", "huge.svg")],
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "artifact_too_large_for_agent" } satisfies Partial<PromptArtifactError>);
});

test("Given a PDF and a Word document, When artifacts resolve, Then the agent receives the bytes and a workspace path", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n");
    const docx = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const directory = await mkdtemp(join(tmpdir(), "prompt-attachments-"));
    try {
        const artifacts = await resolvePromptArtifacts(
            (item) => Promise.resolve(item.mimeType === "application/pdf" ? pdf : docx),
            [
                attachment(pdf, "resource", "application/pdf", "brief.pdf"),
                attachment(
                    docx,
                    "resource",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "notes.docx",
                ),
            ],
            new AbortController().signal,
        );
        const resources = await exposePromptDocuments(directory, artifacts.resources, new AbortController().signal);
        const blocks = buildPromptContent(
            { images: [], prompt: "Summarize", resources },
            { ...unsupportedSessionCapabilities(), embeddedContextPrompt: true },
        );
        const documents = resources.filter((resource) => resource.type === "blob");
        expect(documents).toHaveLength(2);
        const pdfDocument = documents[0];
        const docxDocument = documents[1];
        expect(pdfDocument?.type === "blob" && pdfDocument.savedPath).toBeTruthy();
        expect(docxDocument?.type === "blob" && docxDocument.savedPath).toBeTruthy();
        if (pdfDocument?.type !== "blob" || pdfDocument.savedPath === undefined) {
            throw new Error("Expected the PDF to be saved");
        }
        expect(await readFile(pdfDocument.savedPath)).toEqual(Buffer.from(pdf));
        expect(blocks).toContainEqual({
            _meta: { mobius: { savedPath: pdfDocument.savedPath } },
            resource: {
                blob: Buffer.from(pdf).toString("base64"),
                mimeType: "application/pdf",
                uri: "attachment:///brief.pdf",
            },
            type: "resource",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Given a binary file the agent cannot consume, When artifacts resolve, Then it is rejected", async () => {
    const bytes = Uint8Array.of(1, 2, 3);

    await expect(
        resolvePromptArtifacts(
            () => Promise.resolve(bytes),
            [attachment(bytes, "resource", "application/zip", "archive.zip")],
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "artifact_media_type_unsupported" } satisfies Partial<PromptArtifactError>);
});
