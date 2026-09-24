-- Personal visibility is independent of immutable clinical and note content.
CREATE TABLE visibility_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('note','person','document','medication','procedure','observation','test_type','source','source_file')),
  target_id TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  UNIQUE(target_type,target_id,version)
);
CREATE INDEX visibility_events_target ON visibility_events(target_type,target_id,version DESC);
CREATE TRIGGER visibility_events_no_update BEFORE UPDATE ON visibility_events BEGIN SELECT RAISE(ABORT,'Visibility history is append-only'); END;
CREATE TRIGGER visibility_events_no_delete BEFORE DELETE ON visibility_events BEGIN SELECT RAISE(ABORT,'Visibility history is append-only'); END;
INSERT INTO schema_migrations VALUES (6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
