export type ProjectStoragePlacement =
    | { readonly hasShard: false }
    | {
          readonly hasShard: true;
          readonly shard: {
              readonly d1ShardId: string;
              readonly r2BucketId: string;
              readonly revision: number;
          };
      };

export interface ProjectStorageContext {
    readonly projectId: string;
    readonly storagePlacement: ProjectStoragePlacement;
}

export interface ProjectStorageDirectory {
    readonly resolve: (projectId: string, signal: AbortSignal) => Promise<ProjectStorageContext>;
}
