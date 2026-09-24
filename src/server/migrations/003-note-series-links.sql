-- Keep every existing link and its identity while adding links to a whole test series.
DROP TRIGGER note_links_finished_insert;
DROP TRIGGER note_links_finished_update;
DROP TRIGGER note_links_finished_delete;
DROP INDEX note_links_target;
ALTER TABLE note_links RENAME TO note_links_before_series;
CREATE TABLE note_links (id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id), target_type TEXT NOT NULL CHECK(target_type IN ('note','person','observation','test_type','medication','procedure','source','document')), target_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'related', UNIQUE(note_id,target_type,target_id,relation));
INSERT INTO note_links SELECT * FROM note_links_before_series;
DROP TABLE note_links_before_series;
CREATE INDEX note_links_target ON note_links(target_type,target_id);
CREATE TRIGGER note_links_finished_insert BEFORE INSERT ON note_links WHEN EXISTS(SELECT 1 FROM notes WHERE id=NEW.note_id AND status='finished') BEGIN SELECT RAISE(ABORT,'Finished note links cannot be changed'); END;
CREATE TRIGGER note_links_finished_update BEFORE UPDATE ON note_links WHEN EXISTS(SELECT 1 FROM notes WHERE id IN (OLD.note_id,NEW.note_id) AND status='finished') BEGIN SELECT RAISE(ABORT,'Finished note links cannot be changed'); END;
CREATE TRIGGER note_links_finished_delete BEFORE DELETE ON note_links WHEN EXISTS(SELECT 1 FROM notes WHERE id=OLD.note_id AND status='finished') BEGIN SELECT RAISE(ABORT,'Finished note links cannot be changed'); END;

-- Self is the existing patient identity, never another relative or another patient.
INSERT INTO notes(id,kind,status,title,person_id,profile_json,created_at,updated_at)
SELECT 'person-note:self','person','editable','Self',id,
  json_object('name',display_name,'relationship','Self','lifeStatus','unknown'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM people WHERE id='patient' AND NOT EXISTS(SELECT 1 FROM notes WHERE person_id='patient');
-- Restore fields already explicitly supplied in family-history sources. A missing
-- death date does not establish that a relative is alive. Keep sourceRelative intact.
UPDATE notes SET profile_json=json_set(profile_json,
  '$.fullName',coalesce(json_extract(profile_json,'$.fullName'),json_extract(profile_json,'$.realName'),json_extract(profile_json,'$.sourceRelative.realName'),''),
  '$.birthDate',coalesce(json_extract(profile_json,'$.birthDate'),cast(json_extract(profile_json,'$.sourceRelative.birthYear') AS TEXT),''),
  '$.deathDate',coalesce(json_extract(profile_json,'$.deathDate'),cast(json_extract(profile_json,'$.sourceRelative.deathYear') AS TEXT),''),
  '$.lifeStatus',coalesce(json_extract(profile_json,'$.lifeStatus'),case when json_extract(profile_json,'$.sourceRelative.deathYear') IS NOT NULL then 'deceased' else 'unknown' end))
WHERE kind='person';
-- The dedicated source control is retired, but its exact contents remain in notes.
UPDATE notes SET content=content || case when length(content)>0 then char(10)||char(10) else '' end || 'Blood type source: ' || json_extract(profile_json,'$.bloodTypeSource')
WHERE kind='person' AND length(trim(coalesce(json_extract(profile_json,'$.bloodTypeSource'),'')))>0;
UPDATE notes SET profile_json=json_remove(profile_json,'$.bloodTypeSource') WHERE kind='person';
UPDATE notes SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='person';
INSERT INTO schema_migrations VALUES (3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
