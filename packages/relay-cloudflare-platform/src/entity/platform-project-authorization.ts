import * as v from "valibot";

export const PlatformProjectAuthorizationRowSchema = v.object({
    app_id: v.string(),
    lifecycle: v.picklist(["active", "suspended", "deleted"]),
    project_id: v.string(),
});

export type PlatformProjectAuthorizationRow = Readonly<v.InferOutput<typeof PlatformProjectAuthorizationRowSchema>>;
