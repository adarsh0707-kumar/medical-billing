# nginx — development reverse proxy

`nginx.conf` is 20 lines and does exactly one job: put the SPA and the API on a
**single origin** at `http://localhost`, so the browser never makes a
cross-origin request and CORS never enters the picture.

```nginx
location /     -> http://frontend:5173   # Vite dev server, WebSocket upgrade for HMR
location /api  -> http://backend:5000    # forwards X-Real-IP and X-Forwarded-For
```

It is mounted read-only by `docker compose` at
`/etc/nginx/conf.d/default.conf`. There is nothing to install or run separately.

```bash
docker compose up -d nginx
docker compose logs -f nginx
docker compose exec nginx nginx -t          # test the config
docker compose exec nginx nginx -s reload   # reload after an edit
```

## What this is not

This is a **development** proxy. It has no TLS, no gzip, no security headers, no
caching, no rate limiting and no upstream pooling — and it proxies to the Vite
dev server rather than to built static files.

> Earlier versions of this file documented all of those as if they were
> configured. They were not, and never had been. If you are looking for the
> production configuration, it does not exist yet.

Writing it is **Phase 8** in
[`docs/05-roadmap-and-phases.md`](../docs/05-roadmap-and-phases.md), which
covers multi-stage builds serving `vite build` output statically, TLS
termination with HSTS and an 80 → 443 redirect, security headers, gzip, and
removing the host port exposure on Postgres.

The forwarded-header setup matters more than it looks: the API's rate limiter
keys on the client address, and `TRUST_PROXY` has to match the real topology or
the limiter either trusts a spoofed header or treats every request as coming
from one client. See [`docs/07-security.md`](../docs/07-security.md).

One gap worth knowing about now: the `/api` block does **not** set
`X-Forwarded-Proto`, which a TLS-terminating deployment will need.

## Documentation

- [Architecture](../docs/02-architecture.md) — request flow and the production gaps
- [Security](../docs/07-security.md) — the operator hardening checklist
- [Development guide](../docs/06-development-guide.md)

## Licence

[MIT](../LICENSE).
