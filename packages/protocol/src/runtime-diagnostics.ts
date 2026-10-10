import * as v from "valibot";
import { type Identifier, isIdentifier } from "./identifier.ts";

const identifier = v.custom<Identifier>(isIdentifier);
export const runtimeDiagnosticsRequestSchema = v.strictObject({
    kind: v.literal("runtime.diagnostics.read"),
    requestId: identifier,
});
export const runtimeDiagnosticsResultSchema = v.pipe(
    v.strictObject({
        kind: v.literal("runtime.diagnostics.result"),
        requestId: identifier,
        truncated: v.boolean(),
        version: v.pipe(v.string(), v.maxLength(32)),
        entries: v.pipe(
            v.pipe(
                v.array(v.pipe(v.record(v.string(), v.pipe(v.string(), v.maxLength(256))), v.readonly())),
                v.readonly(),
            ),
            v.maxLength(200),
        ),
    }),
    v.check((value) => JSON.stringify(value).length <= 65_536, "Diagnostics exceed the report limit"),
);
export type RuntimeDiagnosticsRequest = Readonly<v.InferOutput<typeof runtimeDiagnosticsRequestSchema>>;
export type RuntimeDiagnosticsResult = Readonly<v.InferOutput<typeof runtimeDiagnosticsResultSchema>>;
export const decodeRuntimeDiagnosticsRequest = (raw: string): RuntimeDiagnosticsRequest =>
    v.parse(runtimeDiagnosticsRequestSchema, JSON.parse(raw));
export const decodeRuntimeDiagnosticsResult = (raw: string): RuntimeDiagnosticsResult =>
    v.parse(runtimeDiagnosticsResultSchema, JSON.parse(raw));
export const encodeRuntimeDiagnosticsRequest = (value: RuntimeDiagnosticsRequest): string =>
    JSON.stringify(v.parse(runtimeDiagnosticsRequestSchema, value));
export const encodeRuntimeDiagnosticsResult = (value: RuntimeDiagnosticsResult): string =>
    JSON.stringify(v.parse(runtimeDiagnosticsResultSchema, value));
