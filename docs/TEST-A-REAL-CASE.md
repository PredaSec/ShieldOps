# Test a Real Case — vulnerable code → pipeline → fix → deploy

One app, one bug, one fix. The developer pushes vulnerable code, the pipeline
blocks it, the results say exactly what to fix, the fixed code goes green and
deploys.

- **App repo (developer):** `root/shieldops-app` — a one-file Flask app (`app.py`)
- **Pipeline (DevSecOps):** the app's `.gitlab-ci.yml` only `include:`s
  `root/shieldops → ci/app-pipeline.yml`. Gates: **G1 Gitleaks → G2 Semgrep →
  G3 Trivy → G6 AI + manual deploy staging → G7 ZAP → G8 AI + manual deploy prod**

---

## 0. Setup (terminal)

```bash
TOKEN=$(cat /tmp/ci_token.txt)
git clone "http://root:${TOKEN}@localhost:8929/root/shieldops-app.git" /tmp/shieldops-app
cd /tmp/shieldops-app
git config user.email dev@keystone.tn && git config user.name "Dev"
git checkout -b feature/ssti

# URL of the app deployed in staging (kind node IP, NodePort 30500)
NODE=$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' shieldops-cluster-control-plane | awk '{print $1}')
echo "staging: http://$NODE:30500   production: http://$NODE:30502"
```

Open in the browser: **GitLab** `http://localhost:8929/root/shieldops-app/-/pipelines`
and the **Dashboard** `http://localhost:8088`.

---

## 1. The vulnerable code

`app.py`:

```python
@app.route("/")
def index():
    name_raw = request.args.get("name", "world")

    # VULNERABLE: user input is pasted INTO the template source
    rendered = render_template_string(
        TEMPLATE.replace("{{ name }}", name_raw),     # ← SSTI
        name_raw=name_raw,
    )
    return rendered

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)    # ← debug + all interfaces
```

`Dockerfile`: `FROM python:3.12-slim` … `CMD ["python", "app.py"]` — **no `USER`,
runs as root**.

**Why it's dangerous:** the user's text becomes part of the Jinja2 template, so
Jinja2 *executes* it on the server (Server-Side Template Injection → remote code
execution). OWASP A03 Injection.

**Prove it** (on the currently deployed app, browser or curl):

| Payload in `?name=` | Result |
|---|---|
| `{{7*7}}` | `Hello, 49!` — the server evaluated it |
| `{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}` | `uid=0(root)` — shell command executed, as root |

```bash
curl -s "http://$NODE:30500/?name=%7B%7B7*7%7D%7D" | grep Hello
```

> On `main` these lines carry `# nosemgrep` — that is a previous **risk
> acceptance** made from the dashboard. Remove them so the scanner judges the
> real code:

```bash
sed -i 's/  # nosemgrep$//' app.py
git commit -am "feat: greeting page"
git push origin feature/ssti
```

---

## 2. Watch the pipeline → it goes RED

GitLab → Pipelines → the `feature/ssti` run:

| Gate | Result | Why |
|---|---|---|
| G1 `g1-secrets` (Gitleaks) | ✅ passed | no secret in the code |
| G2 `g2-sast` (Semgrep) | ❌ **failed** | 4 findings (below) |
| G3, G6, G7, G8 | ⏭ skipped | the pipeline stops at the first failed gate |

The vulnerable image is **never built and never deployed**.

---

## 3. Read the results → what to fix

Where to look: click **`g2-sast`** → job log (`Ran … rules: 4 findings`), or
download the **`semgrep.json`** artifact (right panel → *Browse*), or open the
run on the **Dashboard** (findings listed per gate).

| # | Semgrep rule | Where | Meaning | Fix |
|---|---|---|---|---|
| 1 | `render-template-string` | `app.py:49` | template built from user input → SSTI | use a static template file + pass the input as a variable |
| 2 | `debug-enabled` | `app.py:56` | `debug=True` exposes the Werkzeug console (RCE) | read debug from an env var, off by default |
| 3 | `avoid_app_run_with_bad_host` | `app.py:56` | hard-coded `0.0.0.0` | read the bind address from an env var |
| 4 | `missing-user` (severity ERROR) | `Dockerfile:12` | container runs as root | add a non-root `USER` |

---

## 4. The fix

**`templates/index.html`** (new file) — the old `TEMPLATE` string moved to a
file; the input is now a *variable*, `{{ name }}`, which Jinja2 auto-escapes:

```html
<input name="name" value="{{ name }}" size="60" />
...
<pre>Hello, {{ name }}!</pre>
```

(Create it by copying the HTML from the old `TEMPLATE` string and replacing
`{{ name_raw }}` with `{{ name }}`.)

**`app.py`**:

```python
import os

from flask import Flask, request, render_template

app = Flask(__name__)


@app.route("/")
def index():
    name = request.args.get("name", "world")
    # FIXED: the template is a static file and `name` is passed as data.
    # Jinja2 auto-escapes it, so {{7*7}} is shown as text, never executed.
    return render_template("index.html", name=name)


if __name__ == "__main__":
    # FIXED: debug mode and bind address come from the environment,
    # never hard-coded (debug=True exposes the Werkzeug console = RCE).
    app.run(
        host=os.environ.get("FLASK_RUN_HOST", "127.0.0.1"),
        port=5000,
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
```

**`Dockerfile`**:

```dockerfile
FROM python:3.12-slim

# FIXED: apply Debian security updates (base image ships CVE-affected packages, e.g. perl-base)
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates/ templates/

# FIXED: run as an unprivileged user, not root
RUN useradd --create-home appuser
USER appuser

ENV FLASK_RUN_HOST=0.0.0.0
EXPOSE 5000

CMD ["python", "app.py"]
```

```bash
git add -A
git commit -m "fix: SSTI — static template + autoescape, no debug, non-root container"
git push origin feature/ssti
```

---

## 5. The fixed pipeline → GREEN, AI advises, human approves

| Gate | Result |
|---|---|
| G1 Gitleaks | ✅ |
| G2 Semgrep | ✅ 0 findings |
| G3 build image + Trivy (deps + image CVEs) | ✅ |
| G6 AI analysis | ✅ report → recommendation **DEPLOY** |
| G6 `g6-deploy-staging` | ⏸ **manual** — a human clicks ▶ (GitLab) or *Approve* (Dashboard) |
| G7 ZAP baseline (DAST on the live staging app) | ✅ |
| G8 AI analysis (all reports incl. ZAP) | ✅ |
| G8 `g8-deploy-production` | ⏸ **manual** — approve again |

The AI **does not detect anything** — it reads the reports of G1–G7 and explains
them in one verdict. If any CRITICAL finding exists it is forced to
`BACK_TO_DEV`. The human makes the final call.

```bash
KUBECONFIG=/tmp/kc kubectl get pods -n staging
KUBECONFIG=/tmp/kc kubectl get pods -n production
```

---

## 6. Prove the fix

```bash
curl -s "http://$NODE:30500/?name=%7B%7B7*7%7D%7D" | grep Hello
#  before:  Hello, 49!
#  after:   Hello, {{7*7}}!          ← printed as text, not executed

POD=$(KUBECONFIG=/tmp/kc kubectl get pods -n staging -o name | grep ssti | head -1)
KUBECONFIG=/tmp/kc kubectl exec -n staging "$POD" -- id
#  before:  uid=0(root)
#  after:   uid=1000(appuser)
```

Bonus: that `kubectl exec` also fires a **Falco** alert (shell in container) →
Grafana `http://localhost:3000` → *ShieldOps — Security Posture*.

---

## Bonus case — a committed secret (G1, ~1 min to red)

```bash
printf '\nAWS_ACCESS_KEY_ID = "AKIA2E0A8F3B244C9986"\n' >> app.py
git commit -am "add config" && git push origin feature/ssti
```

→ **G1 Gitleaks fails** (`leaks found: 1`), everything after is skipped.
**Fix:** delete the line, read the key from an environment variable / Secrets
Manager, and **rotate the key** (once pushed, consider it leaked).

```bash
git revert --no-edit HEAD && git push origin feature/ssti
```

---

## Timing on this machine (plan the demo around it)

| Part | Approx. |
|---|---|
| G1 + G2 → red | ~2 min — fine to run **live** |
| full green run (all gates + both approvals) | ~45–50 min (ZAP alone ~10 min) |

So: push the vulnerable code **live** and wait for the red G2. Run the green
(fixed) pipeline **before the presentation**, and live just open the finished
run. Run the exploits (steps 1 and 6) live — they are instant.

## Reset

```bash
bash scripts/demo-reset.sh   # from the repository root
```
