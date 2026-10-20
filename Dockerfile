# syntax=docker/dockerfile:1.7
# Multi-stage production image for the single PanahGozar web service.
#
# SECURITY / PLATFORM NOTE: this image runs the unprivileged HTTP panel only.
# It grants no VPN/proxy network capabilities, no host networking, no UDP
# ingress, and no kernel modules. Protocol listeners are hosted externally.
# See docs/compatibility.md.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Prisma Client must exist before tsc emits the server build.
RUN pnpm db:generate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    RUN_MIGRATIONS_ON_START=1 \
    RUN_SEED_ON_START=1
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER node

# Advisory only. Railway/Render use their own HTTP health checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
