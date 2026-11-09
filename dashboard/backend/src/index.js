'use strict';

require('dotenv').config();

const { installGlobalRedaction } = require('./middleware/redact');
// Install credential redaction BEFORE any other require that might log
installGlobalRedaction();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const client     = require('prom-client');

const { loginHandler } = require('./middleware/auth');
const pipelinesRouter  = require('./routes/pipelines');
const reportsRouter    = require('./routes/reports');
const webhooksRouter   = require('./routes/webhooks');
const notifRouter      = require('./routes/notifications');
const linksRouter      = require('./routes/links');
const awsRouter        = require('./routes/aws');
const clusterRouter    = require('./routes/cluster');

const app  = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

// Behind the frontend nginx proxy and reachable from GitLab (which sets
// X-Forwarded-For); trust the first proxy so express-rate-limit keys correctly.
app.set('trust proxy', 1);

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name:       'http_request_duration_seconds',
  help:       'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers:  [register],
});

// Security headers
app.use(helmet({
  crossOriginEmbedderPolicy: false, // allow SSE
}));

// CORS — allow the Vite dev server and configured frontend origin
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:8088').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Request timing
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.path, status_code: res.statusCode });
  });
  next();
});

// Global rate limit
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders:   false,
}));

// --- Routes ---

app.post('/api/auth/login', loginHandler);

app.use('/api/pipelines',     pipelinesRouter);
app.use('/api/reports',       reportsRouter);
app.use('/api/analyze',       reportsRouter); // /api/analyze proxied via reports router
app.use('/api/webhooks',      webhooksRouter);
app.use('/api/notifications', notifRouter);
app.use('/api',               linksRouter);  // /api/links, /api/settings
app.use('/api/aws',           awsRouter);
app.use('/api/cluster',       clusterRouter);

// Health check
app.get('/healthz', (req, res) => {
  res.json({
    status:    'ok',
    service:   'shieldops-dashboard',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[shieldops-dashboard] Backend listening on port ${PORT}`);
  });
}

module.exports = app;
