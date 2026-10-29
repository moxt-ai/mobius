import type { z } from "zod";

/** Construct branded values through their owning schema, never a type assertion. */
export type BrandedType<Value, Name extends string> = Value & z.$brand<Name>;
