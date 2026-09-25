# Build context is the repository root (see docker-compose.yml).
#
#   docker build -f services/notifier/Dockerfile -t poa-notifier .

FROM node:22-slim AS build
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poa/notifier...

# Tests have no place in a runtime image, and the service tsconfig lists `test/**/*.ts` under a `src` rootDir,
# which `tsc` refuses to emit (TS6059). Dropping them here keeps `pnpm build` working without a config change.
RUN rm -rf services/notifier/test services/shared/test
RUN pnpm --filter @poa/shared build && pnpm --filter @poa/notifier build

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo /repo

# NODE_ENV=production turns on the webhook SSRF guard: https only, no private or link-local addresses.
ENV NODE_ENV=production \
    PORT=4004 \
    HOST=0.0.0.0 \
    CHECKPOINT_DISABLE=1
USER node
EXPOSE 4004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4004/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Tables first: `prisma db push` creates or extends them and never drops data (a destructive change stops the
# start instead), so a fresh database needs no manual step. When the Postgres is shared with the indexer, give this
# service a schema of its own: DATABASE_URL=…?schema=verifaid.
# The worker runs in the same process; SIGTERM stops it after the in-flight batch.
CMD ["sh", "-c", "services/shared/node_modules/.bin/prisma db push --schema services/shared/prisma/schema.prisma --skip-generate && exec node services/notifier/dist/server.js"]
