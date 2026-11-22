# Single-container image: API + built frontend served by the same process.
# The base image is pinned to a full Node version on purpose: Dependabot bumps
# it, so a Node release arrives as a PR, and merging it republishes and
# redeploys the image. A floating tag like node:26-slim never changes in the
# file, so nothing would ever rebuild.
FROM node:26.13.1-slim AS build
WORKDIR /app
# prisma.config.ts resolves DATABASE_URL even for `generate` — any value works at build time.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build

COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci
COPY backend backend
RUN cd backend && npx prisma generate && npm run build

COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci
COPY frontend frontend
RUN cd frontend && npm run build

FROM node:26.13.1-slim
WORKDIR /app/backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3020 STATIC_DIR=/app/frontend/dist

# The prisma CLI's schema engine (`migrate deploy` at startup) needs libssl. The
# slim image ships none, so Prisma guesses openssl-1.1.x and warns on every start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Full install kept on purpose: the prisma CLI is needed at startup for
# `migrate deploy`, and it lives in devDependencies.
COPY --from=build /app/backend/node_modules node_modules
COPY --from=build /app/backend/dist dist
COPY --from=build /app/backend/src/generated src/generated
COPY backend/package.json backend/prisma.config.ts ./
COPY backend/prisma prisma
COPY --from=build /app/frontend/dist /app/frontend/dist

# Run unprivileged. Defaults to the image's `node` user (1000:1000); any other
# UID/GID works too (`user:` in compose, `--user` on docker run) since nothing
# under /app is written at runtime. The prisma binary is called directly rather
# than through npx, which wants a writable npm cache in $HOME.
ENV CHECKPOINT_DISABLE=1
USER node

EXPOSE 3020
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/server.js"]
