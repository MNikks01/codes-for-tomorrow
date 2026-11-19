# syntax=docker/dockerfile:1.7

# ---- base: pinned Node LTS + pnpm --------------------------------------------
FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@12.6.0 && npm cache clean --force
WORKDIR /app

# ---- deps: full dependency tree from the lockfile ----------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- prod-deps: production dependencies only, from the same lockfile --------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# shortcut: pnpm keeps @prisma/client's *optional* peers (the prisma CLI, typescript)
# in the prod snapshot because they are dev dependencies. They are never loaded at
# runtime (migrations run from the `migrate` image), so they are removed here.
# Revisit when pnpm can drop resolved optional peers from --prod installs.
RUN pnpm install --frozen-lockfile --prod \
  && cd node_modules/.pnpm \
  && rm -rf prisma@* @prisma+studio-core@* @prisma+dev@* @prisma+engines@* \
    @prisma+fetch-engine@* typescript@* effect@* @electric-sql+* mysql2@* \
    react@* react-dom@* elkjs@* @radix-ui+* @visx+* @types+* \
  && rm -rf /root/.cache /root/.local/share/pnpm

# ---- build: compile TypeScript (generated Prisma client is compiled into dist) -
FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm build

# ---- migrate: one-shot job that applies committed migrations -----------------
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN chown -R node:node /app
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ---- runtime: minimal, non-root, production deps only ------------------------
FROM node:24-bookworm-slim AS runtime
# The runtime never uses npm/corepack; removing them drops their bundled CVEs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
  PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM/SIGINT so the app can shut down gracefully.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
