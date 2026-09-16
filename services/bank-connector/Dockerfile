# Build context is the repository root (see docker-compose.yml).
#
#   docker build -f services/bank-connector/Dockerfile -t poa-bank-connector .

FROM node:22-slim AS build
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poa/bank-connector...

# Tests have no place in a runtime image, and the service tsconfig lists `test/**/*.ts` under a `src` rootDir,
# which `tsc` refuses to emit (TS6059). Dropping them here keeps `pnpm build` working without a config change.
RUN rm -rf services/bank-connector/test services/shared/test
RUN pnpm --filter @poa/shared build && pnpm --filter @poa/bank-connector build

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo /repo

ENV NODE_ENV=production \
    PORT=4003 \
    HOST=0.0.0.0
USER node
EXPOSE 4003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4003/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/bank-connector/dist/server.js"]
