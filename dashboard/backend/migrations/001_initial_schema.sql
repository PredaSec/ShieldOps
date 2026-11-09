-- ShieldOps Dashboard — initial schema
-- Pipeline runs ingested from GitLab webhooks
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                 SERIAL PRIMARY KEY,
  gitlab_pipeline_id BIGINT NOT NULL UNIQUE,
  commit_sha         TEXT   NOT NULL,
  branch             TEXT   NOT NULL DEFAULT 'unknown',
  status             TEXT   NOT NULL DEFAULT 'pending',
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Gate results per pipeline
CREATE TABLE IF NOT EXISTS gate_results (
  id              SERIAL PRIMARY KEY,
  pipeline_id     INTEGER NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  gate_name       TEXT    NOT NULL,
  tool            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  severity_counts JSONB,
  report_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI analysis reports per pipeline stage
CREATE TABLE IF NOT EXISTS ai_reports (
  id              SERIAL PRIMARY KEY,
  pipeline_id     INTEGER NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage           TEXT    NOT NULL,
  content_md      TEXT,
  recommendation  TEXT,
  risk_level      TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deployment decisions (approve / reject)
CREATE TABLE IF NOT EXISTS deployments (
  id           SERIAL PRIMARY KEY,
  pipeline_id  INTEGER NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  environment  TEXT    NOT NULL DEFAULT 'production',
  status       TEXT    NOT NULL DEFAULT 'pending',
  approved_by  TEXT,
  decided_at   TIMESTAMPTZ,
  comment      TEXT,
  job_id       TEXT,
  aws_region   TEXT,
  app_url      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One decision record per pipeline+environment (target for the approve/reject upsert).
  UNIQUE (pipeline_id, environment)
);

-- Notification log
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  pipeline_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  channel     TEXT    NOT NULL DEFAULT 'email',
  recipients  TEXT[]  NOT NULL DEFAULT '{}',
  sent_at     TIMESTAMPTZ,
  status      TEXT    NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Settings (notification recipients etc.)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default settings
INSERT INTO settings (key, value) VALUES
  ('notification_recipients', '["ops@example.com"]'),
  ('links', '{
    "grafana":    "http://localhost:3000",
    "prometheus": "http://localhost:9090",
    "loki":       "http://localhost:3100",
    "zap":        "http://localhost:8080",
    "trivy":      "http://localhost:4954",
    "semgrep":    "http://localhost:7700",
    "gitlab":     "http://localhost:8929/root/shieldops"
  }')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_gitlab_id ON pipeline_runs(gitlab_pipeline_id);
CREATE INDEX IF NOT EXISTS idx_gate_results_pipeline   ON gate_results(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_ai_reports_pipeline     ON ai_reports(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_deployments_pipeline    ON deployments(pipeline_id);
