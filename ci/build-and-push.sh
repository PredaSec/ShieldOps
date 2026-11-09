#!/usr/bin/env bash
# =============================================================================
# ci/build-and-push.sh
#
# Build the backend and frontend Docker images and push them to the internal
# registry (registry:5000).
#
# Usage:
#   build-and-push.sh <image-tag>
#
# Environment:
#   REGISTRY          — registry host:port (default: registry:5000)
#   CI_PIPELINE_ID    — used as fallback tag if <image-tag> not given
#
# Images produced:
#   registry:5000/shieldops-backend:<tag>
#   registry:5000/shieldops-frontend:<tag>
#
# Notes:
# - The runner must have Docker available (Docker-in-Docker or Docker socket).
# - The registry at registry:5000 is plain HTTP; the Docker daemon must have
#   it listed under insecure-registries.
# - After push, run:
#     kind load docker-image registry:5000/shieldops-backend:<tag>
#   to make the image available inside the kind cluster (IfNotPresent pull).
# =============================================================================

set -euo pipefail

TAG="${1:-${CI_PIPELINE_ID:-latest}}"
REGISTRY="${REGISTRY:-registry:5000}"

BACKEND_IMAGE="${REGISTRY}/shieldops-backend:${TAG}"
FRONTEND_IMAGE="${REGISTRY}/shieldops-frontend:${TAG}"

echo "[build-and-push] Tag: ${TAG}  Registry: ${REGISTRY}"

# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
echo "[build-and-push] Building backend → ${BACKEND_IMAGE}"
docker build \
  --tag "${BACKEND_IMAGE}" \
  --label "pipeline=${CI_PIPELINE_ID:-local}" \
  --label "git-sha=${CI_COMMIT_SHA:-unknown}" \
  --file app/backend/Dockerfile \
  app/backend/

echo "[build-and-push] Pushing ${BACKEND_IMAGE}"
docker push "${BACKEND_IMAGE}"

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
echo "[build-and-push] Building frontend → ${FRONTEND_IMAGE}"
docker build \
  --tag "${FRONTEND_IMAGE}" \
  --label "pipeline=${CI_PIPELINE_ID:-local}" \
  --label "git-sha=${CI_COMMIT_SHA:-unknown}" \
  --file app/frontend/Dockerfile \
  app/frontend/

echo "[build-and-push] Pushing ${FRONTEND_IMAGE}"
docker push "${FRONTEND_IMAGE}"

echo "[build-and-push] Done."
echo "BACKEND_IMAGE=${BACKEND_IMAGE}"
echo "FRONTEND_IMAGE=${FRONTEND_IMAGE}"
