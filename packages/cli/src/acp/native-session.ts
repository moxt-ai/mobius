import { z } from "zod";

const path = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !value.includes("\0"));
const title = z.string().transform((value) => value.slice(0, 500));
export const nativeSessionIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/);
const nativeSessionInfoSchema = z
  .object({
    sessionId: nativeSessionIdSchema,
    cwd: path,
    additionalDirectories: z.array(path).max(16).default([]).readonly(),
    title: title.nullish(),
    updatedAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .readonly();
export type NativeSessionInfo = z.infer<typeof nativeSessionInfoSchema>;
export const nativeSessionPageSchema = z
  .object({
    sessions: z.array(nativeSessionInfoSchema).max(500).readonly(),
    nextCursor: z.string().min(1).max(4_096).nullish(),
  })
  .readonly();
export type NativeSessionPage = z.infer<typeof nativeSessionPageSchema>;

export type NativeSessionOrigin =
  | { readonly kind: "import"; readonly nativeSessionId: string }
  | { readonly kind: "fork"; readonly nativeSessionId: string };
