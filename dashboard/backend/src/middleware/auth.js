'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'shieldops-dashboard-secret-change-in-prod';

/**
 * Basic JWT auth middleware.
 * For /api/aws/* routes (non-negotiable per plan 5.4).
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * POST /api/auth/login — issues a short-lived JWT for dashboard access.
 * In production wire to LDAP/OIDC. For now, single-user env-var credentials.
 */
function loginHandler(req, res) {
  const { username, password } = req.body || {};
  const ADMIN_USER = process.env.DASHBOARD_USER     || 'admin';
  const ADMIN_PASS = process.env.DASHBOARD_PASSWORD || 'changeme';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign(
      { sub: username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    return res.json({ token, expiresIn: '8h' });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
}

module.exports = { requireAuth, loginHandler };
