import type { ProjectStoragePlacement } from "./project-storage-directory.ts";

export interface ProjectDatabaseBindings {
    readonly resolve: (placement: ProjectStoragePlacement) => D1Database;
}
