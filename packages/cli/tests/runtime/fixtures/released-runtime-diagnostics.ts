import { z } from "zod";

// Independent receiver contract from SDK 0.0.143 at Mobius 7ea98e8b.
// Keep this fixture unchanged when the production diagnostics schema evolves.
const identifier = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const resultSchema = z
    .strictObject({
        kind: z.literal("runtime.diagnostics.result"),
        requestId: identifier,
        truncated: z.boolean(),
        version: z.string().max(32),
        entries: z
            .array(z.record(z.string(), z.string().max(256)).readonly())
            .max(200)
            .readonly(),
    })
    .refine((value) => JSON.stringify(value).length <= 65_536, "Diagnostics exceed the report limit");

export function decodeReleasedRuntimeDiagnostics(raw: string) {
    return resultSchema.parse(JSON.parse(raw));
}
