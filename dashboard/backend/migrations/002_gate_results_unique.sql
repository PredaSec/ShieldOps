-- Fix the webhook duplicate-gates bug: gate_results had no unique key, so the
-- handler's ON CONFLICT never matched and every pipeline event re-inserted all
-- gate rows. Dedupe existing rows (keep the most recent per pipeline+gate),
-- then add the unique constraint the upsert relies on.

DELETE FROM gate_results a
USING gate_results b
WHERE a.pipeline_id = b.pipeline_id
  AND a.gate_name   = b.gate_name
  AND a.id < b.id;

ALTER TABLE gate_results
  ADD CONSTRAINT gate_results_pipeline_gate_uniq UNIQUE (pipeline_id, gate_name);

-- One AI report per pipeline+stage (target for the CI report-ingest upsert).
DELETE FROM ai_reports a
USING ai_reports b
WHERE a.pipeline_id = b.pipeline_id
  AND a.stage = b.stage
  AND a.id < b.id;

ALTER TABLE ai_reports
  ADD CONSTRAINT ai_reports_pipeline_stage_uniq UNIQUE (pipeline_id, stage);
