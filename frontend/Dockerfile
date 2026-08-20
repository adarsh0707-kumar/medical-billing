# Production image. The development one is Dockerfile.dev, which runs the Vite
# dev server with the source mounted; this one builds once and serves the output
# as static files. There is no Node process at runtime.

# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
# --legacy-peer-deps matches CI and the dev image; React 19 is newer than some
# transitive peer ranges in the shadcn/Radix tree.
RUN npm ci --legacy-peer-deps

COPY . .

# No VITE_API_URL is set on purpose. The client calls /api on whatever origin
# served it, and nginx proxies that to the backend, so the bundle is not tied to
# a hostname and the same image can run in any environment.
RUN npm run build

# ─── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# Serves the SPA and handles client-side routing. TLS and the security headers
# are the edge proxy's job, not this one's.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
