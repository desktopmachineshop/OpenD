# One image for every hosted service: `serve`, `worker`, `migrate` and `seed`.
# Build from the repository root:  docker build -f deploy/Dockerfile -t opend .

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @opend/server deploy --prod --legacy /out

FROM node:22-bookworm-slim
# The worker shells out to git to fetch the pushed commit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
# Created here so a fresh named volume inherits the node user's ownership.
RUN mkdir -p /data/blobs && chown -R node:node /data
ENV NODE_ENV=production \
    BLOB_DIR=/data/blobs \
    PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["serve"]
