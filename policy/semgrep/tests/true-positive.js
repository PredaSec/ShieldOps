'use strict';

// =============================================================================
// TRUE POSITIVE TEST CASES — these MUST be flagged by the custom Semgrep rules.
// Each `ruleid:` comment tells semgrep --test which rule should fire on the
// immediately-following statement.
// =============================================================================

const { Pool, Client } = require('pg');
const pool   = new Pool();
const client = new Client();

// TP-1: Exact V2 pattern from the app — string concat assigned to var, then
//       pool.query(sql) with no parameterised array.
async function searchVuln1(keyword) {
  // ruleid: shieldops.nodejs.sqli-pg-concat-var
  const sql = "SELECT id, title, description, status, created_at FROM tasks WHERE title ILIKE '%" + keyword + "%' OR description ILIKE '%" + keyword + "%' ORDER BY created_at DESC";
  const result = await pool.query(sql);
  return result.rows;
}

// TP-2: Two-value concatenation — also a SQL injection risk.
async function searchVuln2(userFilter) {
  // ruleid: shieldops.nodejs.sqli-pg-concat-var
  const query = "SELECT * FROM tasks WHERE status = '" + userFilter + "'";
  await pool.query(query);
}

// TP-3: Template literal passed directly to pool.query() — dynamic expression.
async function searchVuln3(userId) {
  // ruleid: shieldops.nodejs.sqli-pg-template-literal
  return pool.query(`SELECT * FROM users WHERE id = ${userId}`);
}

// TP-4: Template literal using client.query() — dynamic expression, flagged.
async function searchVuln4(status) {
  // ruleid: shieldops.nodejs.sqli-pg-template-literal
  return client.query(`SELECT * FROM tasks WHERE status = '${status}'`);
}
