# syntax=docker/dockerfile:1
# Eén keer bouwen, hetzelfde image uitrollen (op digest). Base image vastgezet op digest;
# Dependabot houdt hem bij.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
RUN corepack enable

FROM base AS build
# Bouwgereedschap voor better-sqlite3 als er geen prebuilt binary is
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# De publieke origin wordt bij het bouwen vastgelegd (SvelteKit 3: paths.origin)
ARG ORIGIN
RUN test -n "$ORIGIN" || (echo "ORIGIN is verplicht" && exit 1)
RUN ORIGIN="$ORIGIN" pnpm build

FROM build AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Amsterdam \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/budget.db \
    MIGRATIONS_DIR=/app/drizzle \
    ADDRESS_HEADER=x-real-ip \
    BODY_SIZE_LIMIT=25M \
    COOKIE_SECURE=true
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts/setup-token.mjs ./scripts/setup-token.mjs
# Niet als root; de code is van root en dus niet door de app te wijzigen
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "build"]
