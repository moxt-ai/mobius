CREATE TABLE platform_project_storage_placements (
    project_id TEXT PRIMARY KEY,
    d1_shard_id TEXT NOT NULL CHECK (length(d1_shard_id) > 0),
    r2_bucket_id TEXT NOT NULL CHECK (length(r2_bucket_id) > 0),
    placement_revision INTEGER NOT NULL CHECK (placement_revision > 0)
);
