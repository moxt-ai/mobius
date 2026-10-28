import type { PromptResourceInput } from "../../acp/client/prompt-content.ts";
import { writePromptAttachmentFile } from "../../storage/files/prompt-attachment-file.ts";
import { PromptArtifactError } from "./prompt-artifacts.ts";

/**
 * Copies binary prompt documents into the session workspace and records that path on the
 * attachment. The chat still shows the file itself; Agents read the saved path from prompt metadata.
 */
export async function exposePromptDocuments(
    cwd: string,
    resources: readonly PromptResourceInput[],
    signal: AbortSignal,
): Promise<readonly PromptResourceInput[]> {
    const exposed: PromptResourceInput[] = [];
    for (const resource of resources) {
        signal.throwIfAborted();
        if (resource.type !== "blob") {
            exposed.push(resource);
            continue;
        }
        const bytes = Buffer.from(resource.data, "base64");
        let saved: string;
        try {
            saved = await writePromptAttachmentFile(cwd, { bytes, name: resource.name }, signal);
        } catch (cause) {
            if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
                throw cause;
            }
            throw new PromptArtifactError(
                "artifact_store_failed",
                "The prompt attachment could not be saved for the agent",
                {
                    cause,
                },
            );
        }
        exposed.push({ ...resource, savedPath: saved });
    }
    return exposed;
}
