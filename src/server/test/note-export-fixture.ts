import { openDatabase } from '../database.ts';
import { createNote } from '../notes.ts';
export function exportFixture(path: string, profile = 'cookie-dough') {
  const db = openDatabase(path, profile);
  db.exec(`INSERT INTO providers VALUES('issuer','Fictional Clinic'),('capture','Fictional Import Service');
    INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('file','capture','providers/fictional/report.pdf','synthetic-sha256',100);
    INSERT INTO source_records(id,source_file_id,provider_id,source_key,raw_json,locator_json) VALUES('raw','file','capture','source-42','{}','{"pages":[2,3]}');
    INSERT INTO test_types(id,label,unit) VALUES('cbc','Hemoglobin','g/dL');
    INSERT INTO observations(id,test_type_id,source_record_id,provider_id,label,effective_at,date_precision,value_text,value_numeric,unit,reference_json,status) VALUES
    ('lab-1','cbc','raw','issuer','Hemoglobin','2026-07-01','day','12.4',12.4,'g/dL','{"low":12,"high":16}','final'),
    ('lab-2','cbc','raw','issuer','Hemoglobin','2026-08-01','day','13.1',13.1,'g/dL','{"low":12,"high":16}','final'),
    ('lab-partial','cbc','raw','issuer','Hemoglobin','2026','year','13.6',13.6,'g/dL','{}','final'),
    ('lab-error','cbc','raw','issuer','Hemoglobin','2026-08-05','day','999',999,'g/dL','{}','entered-in-error');
    INSERT INTO medications(id,source_record_id,provider_id,kind,label,status,dose_text,start_at) VALUES
    ('old-order','raw','issuer','order','Old source active prescription','active','10 mg','2024-01-01'),
    ('current-med','raw','issuer','order','Personally confirmed medication','inactive','5 mg daily','2026-08-01');
    INSERT INTO medication_preferences VALUES('current-med','current',1,'2026-09-01','{"actor":"Profile owner","basis":"Patient confirmed"}');
    INSERT INTO documents(id,source_record_id,provider_id,title,effective_at,text_content,extra_json) VALUES('provider-note','raw','issuer','Source progress note','2026-08-01','Provider literal text <script>never run</script>','{"sourceFields":{"type":"Progress Notes","author":["Fictional Clinician"]},"historicalNote":{"title":"Reviewed visit title"}}');`);
  const note = createNote(db, {
    title: 'Questions for my appointment',
    kind: 'historical',
    content:
      '# What I want to discuss\n\n- Review my **recent results**.\n- Bring my medication questions.\n\n## Context\n\nThis fictional note includes a [reference](https://example.test) and an external image reference: ![do not fetch](https://example.test/private.png).\n\n| Topic | Question |\n| --- | --- |\n| Results | What changed? |\n| Follow-up | What should I record? |\n\n<script>never execute</script>',
    textFormats: { content: 'markdown-v1' },
  });
  const sensitive = createNote(db, {
    title: 'Private family context',
    content: 'EXPLICIT SENSITIVE HISTORY',
    kind: 'note',
  });
  return { db, note, sensitive };
}
