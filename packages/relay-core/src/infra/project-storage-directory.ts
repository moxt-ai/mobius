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
    /**
     * Locates the storage of a Project the Relay still serves. A Project that is not active, such as one whose App
     * was deleted, resolves to null, so no credential stored for it authorizes anything.
     */
    readonly resolve: (projectId: string, signal: AbortSignal) => Promise<ProjectStorageContext | null>;
}
