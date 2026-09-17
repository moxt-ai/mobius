ALTER TABLE platform_projects ADD COLUMN location_hint TEXT NOT NULL DEFAULT 'apac'
  CHECK (location_hint IN ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'));
