import { z } from "zod";
import type { BrandedType } from "../../util/branded-type.ts";
import type { NativeSessionQuery } from "../native-history/preview-contract.ts";

const queryKeySchema = z.string().brand<"NativeSessionQueryKey">();
const previewKeySchema = z.string().brand<"NativeSessionPreviewKey">();

export type NativeSessionQueryKey = BrandedType<string, "NativeSessionQueryKey">;
export type NativeSessionPreviewKey = BrandedType<string, "NativeSessionPreviewKey">;

/** Query-process identity is native workspace scope, never a product conversation. */
export function nativeSessionQueryKey(query: NativeSessionQuery): NativeSessionQueryKey {
    return queryKeySchema.parse(
        JSON.stringify([
            query.agent.id,
            query.cwd,
            query.additionalDirectories,
            Object.entries(query.agent.environment).sort(([left], [right]) => left.localeCompare(right)),
        ]),
    );
}

export function nativeSessionPreviewKey(
    queryKey: NativeSessionQueryKey,
    nativeSessionId: string,
): NativeSessionPreviewKey {
    return previewKeySchema.parse(JSON.stringify([queryKey, nativeSessionId]));
}
