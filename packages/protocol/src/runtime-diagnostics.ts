import { z } from "zod";
import { type Identifier, isIdentifier } from "./identifier.ts";

const identifier = z.custom<Identifier>(isIdentifier);
export const runtimeDiagnosticsRequestSchema = z.strictObject({
    kind: z.literal("runtime.diagnostics.read"),
    requestId: identifier,
});
export const runtimeDiagnosticsResultSchema = z
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
export type RuntimeDiagnosticsRequest = Readonly<z.infer<typeof runtimeDiagnosticsRequestSchema>>;
export type RuntimeDiagnosticsResult = Readonly<z.infer<typeof runtimeDiagnosticsResultSchema>>;
export const decodeRuntimeDiagnosticsRequest = (raw: string): RuntimeDiagnosticsRequest =>
    runtimeDiagnosticsRequestSchema.parse(JSON.parse(raw));
export const decodeRuntimeDiagnosticsResult = (raw: string): RuntimeDiagnosticsResult =>
    runtimeDiagnosticsResultSchema.parse(JSON.parse(raw));
export const encodeRuntimeDiagnosticsRequest = (value: RuntimeDiagnosticsRequest): string =>
    JSON.stringify(runtimeDiagnosticsRequestSchema.parse(value));
export const encodeRuntimeDiagnosticsResult = (value: RuntimeDiagnosticsResult): string =>
    JSON.stringify(runtimeDiagnosticsResultSchema.parse(value));
