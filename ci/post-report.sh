#!/bin/sh
# Post a generated AI report to the ShieldOps dashboard (non-fatal).
# Usage: sh ci/post-report.sh <stage> <json-file> <md-file>
# Env: DASHBOARD_URL (default http://dashboard-backend:4000), DASHBOARD_INGEST_TOKEN, CI_PIPELINE_ID
STAGE="$1"; JSON="$2"; MD="$3"
[ -f "$JSON" ] || { echo "[post-report] $JSON missing — skip"; exit 0; }
node -e '
const fs = require("fs");
const [stage, jsonF, mdF] = process.argv.slice(1);
const j  = JSON.parse(fs.readFileSync(jsonF, "utf8"));
const md = fs.existsSync(mdF) ? fs.readFileSync(mdF, "utf8") : "";
const payload = {
  gitlab_pipeline_id: process.env.CI_PIPELINE_ID,
  stage,
  recommendation: j.recommendation,
  risk_level: j.riskLevel || j.risk_level,
  content_md: md,
  raw: j,
};
const url = (process.env.DASHBOARD_URL || "http://dashboard-backend:4000") + "/api/reports/ingest";
(async () => {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gitlab-Token": process.env.DASHBOARD_INGEST_TOKEN || "" },
      body: JSON.stringify(payload),
    });
    console.log("[post-report] dashboard ingest:", r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.log("[post-report] failed (non-fatal):", e.message);
  }
})();
' "$STAGE" "$JSON" "$MD" || true
