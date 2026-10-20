#!/bin/sh
# Single-container entrypoint. Migration is opt-in via environment and is
# enabled by default in the Dockerfile for Railway/Docker deployments, where
# there is no separate release phase. Keep replicas at 1 when enabled.
#
# This process serves the HTTP panel only. It cannot host VPN/proxy listeners;
# see docs/compatibility.md.
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] applying database migrations..."
  ./node_modules/.bin/prisma migrate deploy
  echo "[entrypoint] migrations applied."
fi

if [ "${RUN_SEED_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] seeding idempotent reference data..."
  ./node_modules/.bin/tsx prisma/seed.ts
  echo "[entrypoint] reference data ready."
fi

if [ "$#" -eq 0 ]; then
  set -- node dist/server/index.js
fi
exec "$@"
