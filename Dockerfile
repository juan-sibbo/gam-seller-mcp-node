# GAM Seller MCP Node — Fase B
# Runtime: HTTP transport (StreamableHTTP) + well-known en ruta canónica E-12.
# El bind interno es 0.0.0.0 (necesario para el port mapping de Docker); la EXPOSICIÓN
# la decide el publish del host — mantener "127.0.0.1:3900:3900" hasta que los
# blockers #8/#10 (red piloto / plataforma) se resuelvan con sus actos de infra.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3900

# package.json es necesario en runtime: "type": "module" (ESM)
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Config legal por despliegue — se puede sobreescribir con bind-mount :ro
COPY config ./config

# Non-root + directorios de estado persistente (claves RS256, ledger/denylist)
RUN addgroup -S mcp && adduser -S mcp -G mcp \
    && mkdir -p data keys \
    && chown -R mcp:mcp /app
USER mcp

EXPOSE 3900

# Healthcheck sobre el trust anchor público — si el well-known no firma, el nodo no está sano
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3900/.well-known/seller-mcp-capabilities >/dev/null || exit 1

CMD ["node", "dist/server.js", "--http"]
