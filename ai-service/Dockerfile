# ShieldOps AI Analysis Service
# Multi-stage: deps install → prod image
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Install AWS CLI for S3 uploads (lightweight Python-based awscli via apk)
RUN apk add --no-cache aws-cli python3

# Default port for HTTP mode
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/healthz || exit 1

# Default: run as HTTP server
# Override with: docker run ... node src/index.js analyze --input ...
EXPOSE 3000
CMD ["node", "src/server.js"]

# CLI usage:
#   docker run --rm -e GEMINI_API_KEY=... \
#     -v /path/to/reports:/reports \
#     -v /tmp/out:/out \
#     shieldops-ai node src/index.js analyze --input /reports --out /out --stage staging
