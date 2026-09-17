import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "../schema/index.ts";

export type PlatformDrizzleDatabase = DrizzleD1Database<typeof schema>;

export function platformDrizzle(database: D1Database): PlatformDrizzleDatabase {
    return drizzle(database, { schema });
}
