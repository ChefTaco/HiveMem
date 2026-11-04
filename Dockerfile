FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm --prefix ts-core ci --ignore-scripts && npm --prefix tooling/release ci --ignore-scripts && npm --prefix ts-core run build && npm --prefix ts-core prune --omit=dev --ignore-scripts

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production HIVEMEM_HOST=0.0.0.0 HIVE_AUTO_MIGRATE=false HIVE_AUTO_UPGRADE=false HIVE_UPDATE_CHECK=false HIVE_HOME=/data
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates util-linux openssl && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /build/ts-core/package.json /app/ts-core/package.json
COPY --from=build --chown=node:node /build/ts-core/node_modules /app/ts-core/node_modules
COPY --from=build --chown=node:node /build/ts-core/dist /app/ts-core/dist
COPY LICENSE NOTICE /app/
COPY scripts/container-health.mjs /app/healthcheck.mjs
ENV HIVE_HEALTH_URL=https://localhost:18790/v1/health/ready
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "/app/healthcheck.mjs"]
USER node
WORKDIR /app/ts-core
VOLUME ["/data"]
EXPOSE 18790
ENTRYPOINT ["node", "dist/src/cli.js"]
