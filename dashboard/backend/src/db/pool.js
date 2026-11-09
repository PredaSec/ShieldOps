'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5434', 10),
  database: process.env.DB_NAME     || 'shieldops_dashboard',
  user:     process.env.DB_USER     || 'dashboard',
  password: process.env.DB_PASSWORD || 'dashboard_secret',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

module.exports = pool;
