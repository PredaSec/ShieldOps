'use strict';

// =============================================================================
// TRUE NEGATIVE TEST CASES — these MUST NOT be flagged by the custom rule.
// They demonstrate safe, parameterised patterns that the rule should not catch.
// =============================================================================

const { Pool, Client } = require('pg');
const pool   = new Pool();
const client = new Client();

// TN-1: Safe parameterised query — the canonical correct pattern.
//       pool.query(text, [values]) — no string interpolation.
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeFetchById(id) {
  const result = await pool.query(
    'SELECT id, title, description, status, created_at FROM tasks WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

// TN-2: Safe pattern — literal SQL with no user input, no concatenation.
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeGetAll() {
  const result = await pool.query(
    'SELECT id, title, description, status, created_at FROM tasks ORDER BY created_at DESC'
  );
  return result.rows;
}

// TN-3: Parameterised query with multiple placeholders.
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeInsert(title, description, status) {
  const result = await pool.query(
    'INSERT INTO tasks (title, description, status) VALUES ($1, $2, $3) RETURNING *',
    [title, description, status]
  );
  return result.rows[0];
}

// TN-4: Parameterised ILIKE (the correct fix for V2).
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeSearch(keyword) {
  const result = await pool.query(
    "SELECT id, title, description, status FROM tasks WHERE title ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC",
    [`%${keyword}%`]
  );
  return result.rows;
}

// TN-5: Hardcoded (non-dynamic) template literal — no variable interpolation.
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeReadyz() {
  return pool.query('SELECT 1');
}

// TN-6: client.query() with parameterised array — also safe.
// ok: shieldops.nodejs.sqli-pg-string-concat
async function safeDeleteById(id) {
  await client.query('DELETE FROM tasks WHERE id = $1', [parseInt(id, 10)]);
}
