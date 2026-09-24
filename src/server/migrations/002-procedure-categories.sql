-- Classification is reviewed separately from raw provider evidence. Existing
-- entries remain unspecified; this migration makes no clinical inferences.
ALTER TABLE procedures ADD COLUMN category TEXT NOT NULL DEFAULT 'unspecified'
  CHECK (category IN ('surgery', 'clinical_procedure', 'imaging', 'laboratory', 'pathology', 'unspecified'));
CREATE INDEX procedures_category_date ON procedures(category, effective_at, id);
INSERT INTO schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
