# nginx — reverse proxy

Three nginx configurations live in this repository, and they do different jobs.

| File | Runs where | Job |
|---|---|---|
| `nginx/nginx.conf` | development edge, `docker-compose.yml` | One origin on `http://localhost` — proxies the SPA and `/api` |
| `nginx/nginx.prod.conf` | production edge, `docker-compose.prod.yml` | TLS termination, security headers, and the same single origin |
| `frontend/nginx.conf` | **inside** the frontend image | Serves the built SPA as static files, with the client-side routing fallback |

The first two are mounted at `/etc/nginx/conf.d/default.conf` by their compose
file. The third is baked into the frontend image by `frontend/Dockerfile` and is
not an edge proxy at all: it sets cache headers, but no TLS and no security
headers, because the edge in front of it supplies both.

## Development — `nginx/nginx.conf`

Twenty lines, one job: put the SPA and the API on a **single origin**, so the
browser never makes a cross-origin request and CORS never enters the picture.

```nginx
location /     -> http://frontend:5173   # Vite dev server, WebSocket upgrade for HMR
location /api  -> http://backend:5000    # forwards X-Real-IP and X-Forwarded-For
```

**It is a development proxy and nothing more.** No TLS, no gzip, no security
headers, no caching, no rate limiting, no upstream pooling, and no
`X-Forwarded-Proto`. That is deliberate — it speaks plain HTTP to a Vite dev
server on a laptop. Run the production stack anywhere else.

## Production — `nginx/nginx.prod.conf`

```bash
./scripts/gen-cert.sh                     # or drop a real certificate into certs/
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Everything on `:80` is a `301` to HTTPS; nothing is served over plain HTTP. The
`:443` server terminates TLS 1.2/1.3 with a modern ECDHE cipher list and session
tickets off, and adds:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — one year.
  `preload` is deliberately omitted: it is close to irreversible and belongs to
  whoever owns the domain
- A CSP with `script-src 'self'` and no inline escape. `style-src` still needs
  `'unsafe-inline'` for Tailwind's injected styles, which is the half that
  matters less
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy`
  denying camera, microphone, geolocation and payment
- `server_tokens off`, `client_max_body_size 10m`, and gzip

`/api` proxies to `backend:5000` with `X-Real-IP`, `X-Forwarded-For`,
`X-Forwarded-Proto` and `X-Forwarded-Host` set, plus explicit timeouts. `/` goes
to `frontend:80` — the static build, with no Node process at runtime. `GET
/health` is proxied without the `/api` prefix and kept out of the access log.

Certificates are mounted read-only from `certs/`. `scripts/gen-cert.sh`
generates a self-signed one so the stack runs over HTTPS on any machine with no
domain — **a browser will warn on it, correctly.** Replacing those two files
with a real certificate is the operator's job and nothing in the software can do
it for them.

## Working on it

```bash
docker compose up -d nginx
docker compose logs -f nginx
docker compose exec nginx nginx -t          # test the config
docker compose exec nginx nginx -s reload   # reload after an edit
```

Add `-f docker-compose.prod.yml --env-file .env.prod` for the production stack.

## The forwarded headers matter more than they look

The API's rate limiter keys on the client address, and `TRUST_PROXY` has to
match the real topology — otherwise the limiter either trusts a spoofable header
or treats every request as coming from one client, which lets a busy dashboard
lock out the billing counter. It defaults to the compose network's private
ranges; widen it only if another proxy or a cloud load balancer sits in front.
See [`docs/07-security.md`](../docs/07-security.md).

## Documentation

- [Architecture](../docs/02-architecture.md) — request flow and deployment topology
- [Security](../docs/07-security.md) — the operator hardening checklist
- [Development guide](../docs/06-development-guide.md)

## Licence

[MIT](../LICENSE).
