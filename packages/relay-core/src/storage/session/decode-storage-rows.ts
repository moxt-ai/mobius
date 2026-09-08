import * as v from "valibot";
import { SessionRuntimeError } from "../../service/session/session.ts";

export function decodeStorageRows<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    rows: unknown,
): readonly v.InferOutput<TSchema>[] {
    return decodeStorageRecord(v.array(schema), rows);
}

export function decodeStorageRecord<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    record: unknown,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, record);
    if (!result.success) {
        throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The session database returned an invalid record",
            { cause: new v.ValiError(result.issues) },
        );
    }
    return result.output;
}
