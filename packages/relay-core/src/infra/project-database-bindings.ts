import type { ProjectStoragePlacement } from "./project-storage-directory.ts";
import type { SqlDatabase } from "./sql-database.ts";

export interface ProjectDatabaseBindings {
    readonly resolve: (placement: ProjectStoragePlacement) => SqlDatabase;
}
