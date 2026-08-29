# Production image. The development one is Dockerfile.dev, which mounts the
# source and runs nodemon; this one is self-contained and immutable.
#
# Two stages so the build toolchain and dev dependencies never reach the runtime
# layer. Prisma complicates the usual pattern: `prisma generate` writes a client
# into node_modules that is specific to the schema, so the generated client is
# copied forward rather than regenerated in a layer that has no dev dependencies.

# ─── Stage 1: dependencies and the Prisma client ──────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Prisma's query engine needs OpenSSL. Without it the client fails at runtime
# with an unhelpful "could not locate the query engine" error.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copied before the source so a source change does not invalidate the install.
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma/
RUN npx prisma generate

# Drop dev dependencies now that the client exists. The generated client lives
# under node_modules/.prisma and node_modules/@prisma/client, and survives this.
#
# The prisma CLI is a dev dependency and would go with them — but an operator has
# to be able to run `prisma migrate deploy` inside the deployed container, so it
# is stashed and put back. Keeping it is the difference between a schema change
# being deployable and needing a second image to apply it.
RUN cp -r node_modules/prisma /tmp/prisma-cli \
    && cp node_modules/.bin/prisma /tmp/prisma-bin \
    && npm prune --omit=dev \
    && cp -r /tmp/prisma-cli node_modules/prisma \
    && cp /tmp/prisma-bin node_modules/.bin/prisma \
    && rm -rf /tmp/prisma-cli /tmp/prisma-bin

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
COPY src ./src

# Applies any pending migration before the server starts, then hands off to
# `node` with `exec` so it becomes PID 1 — not a child of this script — and
# still receives SIGTERM directly. Without `exec`, npm's problem repeats one
# layer down: the shell wrapper eats the signal instead of the node process.
#
# `migrate deploy` only applies migrations already committed to
# prisma/migrations; it never generates new ones and is safe to run on every
# boot, including against a database that's already up to date. Copied and
# made executable as root, before dropping to the unprivileged user below —
# `node` cannot chmod a file it doesn't own.
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node:22-slim ships a `node` user (uid 1000). Running as root inside a container
# is not a sandbox escape on its own, but it removes a layer for no benefit.
RUN chown -R node:node /app
USER node

EXPOSE 5000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
