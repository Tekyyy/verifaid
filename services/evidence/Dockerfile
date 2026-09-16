# Build context is the repository root (see docker-compose.yml): the service depends on the @poa/shared
# workspace package, whose Prisma client is generated at build time and must ship with the image.
#
#   docker build -f services/evidence/Dockerfile -t poa-evidence .

FROM node:22-slim AS build
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# The whole workspace is copied (minus .dockerignore) so pnpm can validate the lockfile, but `--filter …^...`
# installs only what this service and @poa/shared need — the frontend and indexer trees are never fetched.
COPY . .
RUN pnpm install --frozen-lockfile --filter @poa/evidence...

# Tests have no place in a runtime image, and the service tsconfig lists `test/**/*.ts` under a `src` rootDir,
# which `tsc` refuses to emit (TS6059). Dropping them here keeps `pnpm build` working without a config change.
RUN rm -rf services/evidence/test services/shared/test
RUN pnpm --filter @poa/shared build && pnpm --filter @poa/evidence build

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo /repo

# Mount points for the master KEK and the local IPFS mock. Owning them as `node` means a fresh named volume
# inherits that ownership, so the service can write without running as root.
RUN mkdir -p /run/secrets /data/ipfs && chown -R node:node /run/secrets /data/ipfs

ENV NODE_ENV=production \
    PORT=4001 \
    HOST=0.0.0.0 \
    NGO_KEK_PATH=/run/secrets/ngo-kek.key \
    IPFS_LOCAL_DIR=/data/ipfs
USER node
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/evidence/dist/server.js"]
