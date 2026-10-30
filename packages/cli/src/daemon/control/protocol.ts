import { z } from "zod";

export const lifecycleResponse = z
    .discriminatedUnion("kind", [
        z.object({
            kind: z.literal("status"),
            protocolVersion: z.literal(2),
            worker: z.object({ pid: z.number().int().positive(), version: z.string() }).readonly().nullable(),
        }),
        z.object({ kind: z.literal("stopped") }),
        z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
    ])
    .readonly();
export type LifecycleResponse = z.infer<typeof lifecycleResponse>;

export function decodeKnownLifecycleResponse(value: unknown): LifecycleResponse | null {
    if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "string" &&
        !["status", "stopped", "error"].includes(value.kind)
    ) {
        return null;
    }
    return lifecycleResponse.parse(value);
}
