# GAM Seller MCP Node — container image
# Runtime: HTTP transport (StreamableHTTP) + signed well-known + /health readiness.
# The internal bind is 0.0.0.0 (needed for Docker port mapping); EXPOSURE is decided by the
# host publish — docker-compose.yml keeps "127.0.0.1:3900:3900"; for public hosting use
# deploy/docker-compose.prod.yml (node behind Caddy/TLS, never mapped to the host).
#
# Operator config is mounted at /app/config at runtime. Secrets (GAM service-account key)
# are never baked in: mount them read-only and point GAM_SA_KEY_PATH at the file.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
    && chmod +x dist/admin/cli.js dist/dsr/cli.js

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3900

# package.json es necesario en runtime: "type": "module" (ESM)
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Bundled config + examples/pilot-publisher (demo fallback). Override with a :ro bind-mount.
# Operator files (gam.json, forecast.json) are excluded by .dockerignore.
COPY config ./config

# Operator CLIs on PATH: `docker compose run --rm seller-mcp-node gam-seller-admin issue-token <id>`
# (run with the node STOPPED — the owner lease refuses state writes against a live node).
RUN ln -s /app/dist/admin/cli.js /usr/local/bin/gam-seller-admin \
    && ln -s /app/dist/dsr/cli.js /usr/local/bin/gam-seller-dsr

# Non-root + persistent state dirs (RS256 keys, ledger/denylist)
RUN addgroup -S mcp && adduser -S mcp -G mcp \
    && mkdir -p data keys \
    && chown -R mcp:mcp /app
USER mcp

EXPOSE 3900

# Readiness: /health answers 200 even when persistence is degraded, so check the flag too —
# a node that cannot write its ledger is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3900/health | grep -q '"persistence_healthy":true' || exit 1

CMD ["node", "dist/server.js", "--http"]
