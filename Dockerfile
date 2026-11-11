ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm --prefix ts-core ci --ignore-scripts && npm --prefix tooling/release ci --ignore-scripts && npm --prefix ts-core run build && npm --prefix ts-core prune --omit=dev --ignore-scripts

FROM ${RUNTIME_IMAGE}
USER root
ENV NODE_ENV=production HIVEMEM_TS_CORE_HOST=0.0.0.0 HIVE_AUTO_MIGRATE=false HIVE_AUTO_UPGRADE=false HIVE_UPDATE_CHECK=false HIVE_HOME=/data
RUN mkdir /data && chown node:node /data
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
