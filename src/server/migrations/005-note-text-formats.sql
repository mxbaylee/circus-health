-- Missing markers mean literal plaintext. Existing bodies remain byte-for-byte unchanged.
ALTER TABLE notes ADD COLUMN text_formats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(text_formats_json));
INSERT INTO schema_migrations VALUES (5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
