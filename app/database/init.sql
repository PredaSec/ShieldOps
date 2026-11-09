-- ShieldOps Phase 2 — Database initialisation
-- Idempotent: safe to run multiple times (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS tasks (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    status      VARCHAR(50)  NOT NULL DEFAULT 'todo',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed data (idempotent via ON CONFLICT DO NOTHING requires a unique constraint,
-- so we use a simple conditional INSERT instead).
INSERT INTO tasks (title, description, status)
SELECT 'Buy groceries', 'Milk, eggs, bread', 'todo'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Buy groceries');

INSERT INTO tasks (title, description, status)
SELECT 'Fix login bug', 'Users cannot log in after password reset', 'in-progress'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Fix login bug');

INSERT INTO tasks (title, description, status)
SELECT 'Write unit tests', 'Cover the auth module with Jest', 'todo'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Write unit tests');

INSERT INTO tasks (title, description, status)
SELECT 'Deploy to staging', 'Push v1.2.0 to the staging namespace', 'done'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Deploy to staging');

INSERT INTO tasks (title, description, status)
SELECT 'Security review', 'Run Trivy + Semgrep before production cut', 'todo'
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Security review');
