ALTER TABLE pairing_channels
ADD COLUMN installable_agents_json TEXT NOT NULL DEFAULT '[]';
