CREATE TABLE medication_preferences (
  medication_id TEXT PRIMARY KEY REFERENCES medications(id),
  status TEXT NOT NULL CHECK(status IN ('current','not_current','unknown')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL,
  assertion_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(assertion_json))
);
-- A provider's order status does not establish personal current use. Existing
-- and newly imported medications stay unknown until an explicit assertion.
INSERT INTO schema_migrations VALUES (4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
