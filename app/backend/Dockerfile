# =============================================================================
# V5 FIX (green-path branch): current pinned LTS base + non-root user.
#   1. Up-to-date base image: node:20.14.0-alpine3.20.
#   2. Runs as the built-in non-root 'node' user so RCE cannot escalate to root.
# =============================================================================

FROM node:20.14.0-alpine3.20

# Patch OS packages — fixes accumulated CVEs in the base image (e.g. the
# openssl CRITICAL CVE-2026-31789 in libssl3/libcrypto3). Keeps Trivy green.
RUN apk --no-cache upgrade

WORKDIR /app

COPY package.json ./
RUN npm install --production && chown -R node:node /app

COPY --chown=node:node src/ ./src/

# V5 FIX: explicit non-root user
USER node

EXPOSE 3001

CMD ["node", "src/index.js"]
