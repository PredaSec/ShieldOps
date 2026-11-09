-- Record which GitLab project each pipeline run belongs to, so the dashboard can
-- act on it (re-run / retry) — runs now come from multiple projects (platform +
-- per-app repos), not just root/shieldops.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS gitlab_project_id BIGINT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS project_web_url   TEXT;
