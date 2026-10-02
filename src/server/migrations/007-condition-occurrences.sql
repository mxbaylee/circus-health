-- Provider condition mentions are sourced occurrences, never personal current-status assertions.
-- Existing source assertions are not converted by this migration.
CREATE TABLE conditions (
  id TEXT PRIMARY KEY NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  provider_id TEXT REFERENCES providers(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  label TEXT NOT NULL,
  effective_at TEXT,
  status TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extra_json))
);
CREATE INDEX conditions_person_date ON conditions(person_id,effective_at,id);
INSERT INTO schema_migrations VALUES (7,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
