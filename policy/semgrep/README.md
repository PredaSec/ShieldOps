# Semgrep Custom Rules — ShieldOps G2

## Overview

This directory contains the custom Semgrep rules for the ShieldOps DevSecOps
pipeline gate G2 (SAST). The rules run alongside the official rulesets
`p/owasp-top-ten` and `p/nodejs`.

## Custom Rule: SQL Injection in node-postgres Queries

**File:** `custom-rules.yaml`

### Problem

The `pg` (node-postgres) library's `query()` method accepts either:

1. A plain string — **safe only if the string contains no user input**
2. A parameterised string + value array: `pool.query("... WHERE id=$1", [id])`

When developers build the SQL string using string concatenation (`+`) or
template literals (`${...}`) and pass the result to `pool.query()` with no
second argument, the query is vulnerable to SQL injection.

### Rules

#### `shieldops.nodejs.sqli-pg-concat-var` (ERROR)

Detects the pattern:

```js
const sql = prefix + userInput + suffix;
pool.query(sql);               // <- no params array
```

This is exactly the V2 vulnerability in `app/backend/src/index.js`:

```js
const sql = "SELECT ... WHERE title ILIKE '%" + keyword + "%' ...";
await pool.query(sql);          // VULN-V2
```

#### `shieldops.nodejs.sqli-pg-template-literal` (ERROR)

Detects template literals with dynamic expressions passed to `pool.query()`:

```js
pool.query(`SELECT * FROM users WHERE id = ${userId}`);  // <- flagged
client.query(`SELECT * FROM tasks WHERE status = '${status}'`);  // <- flagged
```

### What is NOT flagged (safe patterns)

```js
// Safe: parameterised placeholder with values array
pool.query('SELECT ... WHERE id = $1', [id]);

// Safe: static string with no user input
pool.query('SELECT 1');

// Safe: parameterised ILIKE (the correct fix for V2)
pool.query("SELECT ... WHERE title ILIKE $1", [`%${keyword}%`]);
```

### Metadata

| Field       | Value |
|-------------|-------|
| Severity    | ERROR (blocking) |
| CWE         | CWE-89: SQL Injection |
| OWASP       | A03:2021 – Injection |
| Languages   | JavaScript, TypeScript |
| Confidence  | HIGH |

### Testing

Test files are in `tests/`:

| File | Purpose |
|------|---------|
| `true-positive.js` | Cases that MUST be flagged |
| `true-negative.js` | Cases that must NOT be flagged |
| `custom-rules.js`  | Symlink / copy used by `semgrep --test` |

Run:

```bash
# Scan the app for V2
semgrep --config policy/semgrep/custom-rules.yaml app/backend/src/index.js

# Run unit tests (from infrastructure/ root)
semgrep --test policy/semgrep/

# Full SAST with official + custom rules
semgrep --config p/owasp-top-ten --config p/nodejs \
        --config policy/semgrep/custom-rules.yaml \
        --sarif -o semgrep.sarif app/
```

### References

- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [node-postgres Parameterized Queries](https://node-postgres.com/features/queries#parameterized-query)
- [Semgrep Rule Writing](https://semgrep.dev/docs/writing-rules/overview)
