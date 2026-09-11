import type { ProjectStoragePlacement } from "./project-storage-directory.ts";
import type { SqlDatabase } from "./sql-database.ts";

export interface DatabaseResolver {
    readonly resolve: (sharding: ProjectStoragePlacement) => SqlDatabase;
}
