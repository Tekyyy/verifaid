# The indexer as a long-running service (Railway, Render, Fly, a VPS). Build context is the repository root:
#
#   docker build -f indexer/Dockerfile -t verifaid-indexer .
#   docker run -e DATABASE_URL=postgresql://… -e PONDER_RPC_URL=https://… -p 42069:42069 verifaid-indexer
#
# Postgres is required (DATABASE_URL): the container's disk does not outlive a redeploy. Ponder only resumes a
# schema written by the same build, so each deployment indexes into a schema of its own — Railway's deployment id,
# or DATABASE_SCHEMA — starting again from the deployment's start block, which takes a few minutes.

FROM node:22-slim
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
# The indexer and what it imports (@poa/shared) only: no contracts toolchain, no app, no demo.
RUN pnpm install --frozen-lockfile --filter @poa/indexer...
# The shared tsconfig also lists its tests, which `tsc` refuses to emit under a `src` rootDir (see the services).
RUN rm -rf services/shared/test && pnpm --filter @poa/shared build
# Ponder writes its build cache next to the config.
RUN chown -R node:node /repo/indexer

ENV NODE_ENV=production \
    PONDER_NETWORK=base-sepolia \
    PORT=42069
USER node
WORKDIR /repo/indexer
EXPOSE 42069
CMD ["sh", "-c", "exec npx ponder start --schema \"${DATABASE_SCHEMA:-${RAILWAY_DEPLOYMENT_ID:-verifaid}}\""]
