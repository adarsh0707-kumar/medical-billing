# Development Guide

Everything needed to go from a clean checkout to a running, editable system.

---

## 1. Prerequisites

| Tool                | Version | Needed for                                                 |
| ------------------- | ------- | ---------------------------------------------------------- |
| Docker + Compose v2 | current | The recommended path                                       |
| Node.js             | 22.x    | Local (non-Docker) runs — both images use`node:22-slim` |
| npm                 | 10.x    |                                                            |
| PostgreSQL          | 15      | Only if running without Docker                             |

## 2. First run (Docker)

```bash
git clone <repo> && cd medical-billing

# JWT_SECRET is interpolated from the host environment by docker-compose.yml.
# Without it, token signing throws at login.
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
docker compose logs -f backend        # wait for "🚀 Server running on port 5000"

# Create the bootstrap admin
docker compose exec backend npm run seed
```

| URL                          | What                                                     |
| ---------------------------- | -------------------------------------------------------- |
| http://localhost:5173        | The application (Vite dev server)                        |
| http://localhost:5000/health | API health check                                         |
| http://localhost             | Nginx entry point — same app, proxied                   |
| localhost:5432               | Postgres (`medadmin` / `medpass123` / `medicaldb`) |

**Sign in:** `admin@medstore.com` / `admin123` — change it immediately anywhere real.

> **Either entry point works.** `:5173` gives you Vite's HMR and is the one to develop against; `:80` is the nginx path, closest to how a deployment behaves. Both serve the SPA and both forward `/api` to the backend on the same origin, so neither involves CORS ([G-02](./08-gap-analysis.md#g-02)).
>
> The frontend runs on **5173**, not 3000. The root README claimed 3000 until it was corrected on 2026-08-20; `Architecture.txt` still shows it in its original diagram and is superseded by this set.

### Daily Docker commands

```bash
docker compose up -d              # start
docker compose down               # stop (data survives in the pgdata volume)
docker compose down -v            # stop AND destroy the database
docker compose logs -f backend    # follow one service
docker compose restart backend    # after changing .env or docker-compose.yml
docker compose exec backend sh    # shell inside the API container
docker compose exec postgres psql -U medadmin -d medicaldb
```

Source is bind-mounted, so edits on the host hot-reload inside the containers. You only rebuild when dependencies change:

```bash
docker compose build backend && docker compose up -d backend
```

## 3. Running without Docker

```bash
# Postgres must already be running locally.

cd backend
npm install
cat > .env <<'EOF'
DATABASE_URL="postgresql://medadmin:medpass123@localhost:5432/medicaldb"
JWT_SECRET="<32+ random bytes>"
PORT=5000
NODE_ENV=development
EOF
npx prisma migrate dev
npx prisma generate
npm run seed
npm run dev                      # nodemon on :5000

# second terminal
cd frontend
npm install --legacy-peer-deps   # the Docker image uses this flag too
npm run dev                      # Vite on :5173
```

`frontend/.env` is **empty**, which is correct: the client calls `/api` relative to its own origin and the dev server proxies it to `http://localhost:5000`, so it needs no variables at all. Set `VITE_PROXY_TARGET` if the API is elsewhere, or `VITE_API_URL` if it is on another host entirely — then restart Vite, since env values are inlined at build time.

## 4. Environment variables

### Backend

| Variable | Required | Default | Purpose |
| -------- | :------: | ------- | ------- |
| `DATABASE_URL` | ✅ | — | Postgres connection string. Process exits if unreachable |
| `JWT_SECRET` | ✅ | — | HMAC key for tokens. **No fallback** — the process refuses to start without it |
| `CORS_ORIGINS` | ✅ **in production** | — | Comma-separated origins permitted to call the API cross-origin. Under `NODE_ENV=production` this **is** the allowlist; unset means an empty one. `docker-compose.prod.yml` refuses to start without it |
| `PORT` | | `5000` | |
| `NODE_ENV` | | — | `development` enables Prisma query logs and error stacks in responses. Also selects the CORS branch below |
| `FRONTEND_URL` | | — | Appended to the **development** allowlist only. Ignored entirely under `NODE_ENV=production` — set `CORS_ORIGINS` there instead |
| `TRUST_PROXY` | | `loopback, linklocal, uniquelocal` | Express `trust proxy` value — which peers may set `X-Forwarded-For`, and therefore what the rate limiter keys on |
| `LOG_LEVEL` | | `info` | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Silent under `NODE_ENV=test` |
| `RATE_LIMIT_MAX` | | `500` | Requests per 15 minutes per client on `/api` |
| `LOGIN_RATE_LIMIT_MAX` | | `10` | **Failed** logins per 15 minutes on `/api/auth/login`; successes are not counted |
| `CUSTOMER_RETENTION_MONTHS` | | `36` | Inactivity window used by `npm run purge:customers` |
| `AUDIT_RETENTION_MONTHS` | | `24` | Age at which `npm run purge:audit` deletes an audit row |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | **prod** | — | The mail server password-reset links are sent through (FR-AUTH-11). **Required in production** — the API refuses to start without them, because a missing value means resets are accepted and silently never delivered. Unset in development: `sendMail` logs and returns false |
| `APP_URL` | **prod** | — | Public origin of the SPA, no trailing slash. Reset links are `${APP_URL}/reset-password?token=…` |

**The CORS allowlist has two branches, and they share nothing.** Under
`NODE_ENV=production` it is exactly `CORS_ORIGINS`, because "restrict CORS to
your real origin" is impossible to actually do if `localhost:5173` is always
permitted. Otherwise it is the development set — `http://localhost`,
`http://localhost:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`,
`http://172.17.0.1:5173`, plus `FRONTEND_URL` if set.

Either way, requests with **no** `Origin` header (curl, Postman,
server-to-server) are allowed. The SPA is same-origin through nginx or the Vite
proxy, so none of this governs the browser — it governs callers reaching the API
directly.

### Frontend

| Variable              | Required | Default                          | Purpose                                                                                |
| --------------------- | :------: | -------------------------------- | -------------------------------------------------------------------------------------- |
| `VITE_API_URL`      |          | *(empty — relative `/api`)* | Only for an API on another host. Inlined at build time                                 |
| `VITE_PROXY_TARGET` |          | `http://localhost:5000`        | Where the**dev server** forwards `/api` (compose sets `http://backend:5000`) |

### Root

| Variable       | Used by                | Purpose                                 |
| -------------- | ---------------------- | --------------------------------------- |
| `JWT_SECRET` | `docker-compose.yml` | Interpolated into the backend container |

All `.env` files are gitignored. Never commit one.

## 5. Command reference

### Backend (`cd backend`)

| Command                     | Effect                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`             | nodemon on`src/index.js`                                                                                                                                            |
| `npm start`               | plain node                                                                                                                                                            |
| `npm run seed`            | Upsert the admin user                                                                                                                                                 |
| `npm run purge:audit` | Audit-log retention sweep — reports what it would delete and how old. Add `-- --apply` to do it. Never runs itself; see [§ Audit-log retention](#audit-log-retention) |
| `npm run purge:customers` | Retention sweep — reports what it would erase. Add`-- --apply` to do it. Never runs itself; see [§ Customer retention](#customer-retention)                       |
| `npm run prisma:generate` | Regenerate the Prisma client (after any schema edit)                                                                                                                  |
| `npm run prisma:migrate`  | `prisma migrate dev` — author and apply a migration                                                                                                                |
| `npm run prisma:studio`   | Database browser on :5555                                                                                                                                             |
| `npm test`                | Run the suite.**Requires a `DATABASE_URL` whose database name ends in `_test`** — the harness refuses anything else, because it wipes tables between tests |
| `npm run test:watch`      | Same, in watch mode                                                                                                                                                   |
| `npm run test:coverage`   | With a coverage report and the 90% gate on the invoice and auth paths                                                                                                 |

### Frontend (`cd frontend`)

| Command             | Effect                                |
| ------------------- | ------------------------------------- |
| `npm run dev`     | Vite dev server on :5173              |
| `npm run build`   | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Serve the built bundle                |
| `npm run lint`    | ESLint 9 flat config                  |

There is no `npm test`, `npm run format` or `npm run test:coverage` in either package, despite the READMEs mentioning them.

## 6. Database workflow

```bash
# 1. Edit backend/prisma/schema.prisma
# 2. Author + apply the migration
npx prisma migrate dev --name add_something_useful
# 3. Regenerate the client (migrate dev usually does this)
npx prisma generate
```

| Task                               | Command                       |
| ---------------------------------- | ----------------------------- |
| Apply pending migrations (CI/prod) | `npx prisma migrate deploy` |
| Wipe and rebuild (destroys data)   | `npx prisma migrate reset`  |
| Inspect data                       | `npx prisma studio`         |
| Pull schema from an existing DB    | `npx prisma db pull`        |

Inside Docker, prefix with `docker compose exec backend`.

The client is generated for `["native", "linux-musl-openssl-3.0.x"]`, so the same generated output works on the host and in Alpine containers. If you see an `openssl` or engine error after switching environments, run `prisma generate` again.

## 7. Recipe — adding an API endpoint

Worked example: `GET /api/medicines/:id/batches`.

**1. Controller** — `backend/src/controllers/medicine.controller.js`

```js
const getBatches = async (req, res, next) => {
  try {
    const batches = await prisma.batch.findMany({
      where: { medicineId: req.params.id },
      include: { supplier: { select: { name: true } } },
      orderBy: { expiryDate: "asc" },
    });
    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);              // always delegate — never res.status(500) by hand
  }
};

module.exports = { /* … */ getBatches };
```

**2. Validator** (mutating routes only) — `backend/src/validators/inventory.validator.js`

```js
const somethingSchema = z.object({ field: z.string().min(1, "Field is required") });
```

> **Zod strips unknown keys.** Any field missing from the schema never reaches the controller — this is exactly how the `mfgDate` bug happened ([G-04](./08-gap-analysis.md#g-04)). When adding a column, add it to the validator in the same commit.

**3. Route** — `backend/src/routes/inventory.routes.js`

```js
router.get("/medicines/:id/batches", medicineCtrl.getBatches);
// mutating example:
// router.post("/x", authorize("ADMIN", "PHARMACIST"), validate(xSchema), ctrl.create);
```

Order matters: **literal paths before parameterised ones**. `/medicines/search` must stay above `/medicines/:id`, or `search` is read as an id.

**4. Frontend** — call it from a page

```ts
const res = await api.get(`/api/medicines/${id}/batches`);
setBatches(res.data.data);
```

**5. Document it** in [04 — API Reference](./04-api-reference.md) and give it an `FR-` id in [01 — PRD](./01-product-requirements.md).

## 8. Recipe — adding a page

1. Create `frontend/src/pages/Thing.tsx` exporting a default component.
2. Register the route inside the `ProtectedRoute`/`Layout` block in `App.tsx`.
3. Add a `navItems` entry in `components/layout/Sidebar.tsx` with a lucide icon; add `adminOnly: true` to hide it from non-admins — **and enforce the same rule server-side with `authorize()`**, because hiding a link protects nothing.
4. Follow the established page shape: local `useState` + `useEffect` fetch, `loading` skeletons, `toast.success/error` on mutations, refetch after write.

## 9. Code conventions

**Backend**

- CommonJS (`require`/`module.exports`) — not ESM.
- One controller per entity, exporting named handlers.
- Every async handler is wrapped in `try/catch` and calls `next(err)`.
- Responses always use the `{ success, data, message? }` envelope.
- Zod schemas live in `validators/`, never inline in routes.
- Never `SELECT` the password hash except where comparison requires it.
- Access the database only through the `config/db.js` singleton.

**Frontend**

- TypeScript throughout; `@/` aliases `src/`.
- Path alias is configured in both `vite.config.ts` and `tsconfig.app.json` — update both.
- UI primitives come from `components/ui/` (shadcn/ui over Radix); compose, don't restyle from scratch.
- Tailwind v4 via `@tailwindcss/vite`; use `cn()` from `lib/utils` to merge classes.
- All HTTP goes through `lib/api.ts` so the auth interceptors apply.
- Toasts via `sonner`; never `alert()`.
- Icons from `lucide-react`.

**Both**

- Prettier-style formatting: 2 spaces, double quotes, semicolons.
- Commit messages: imperative mood, scoped (`billing:`, `inventory:`, `docs:`).

## 10. Debugging

| Symptom                                 | Where to look                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 401 on every request                    | Token missing/expired in`localStorage`; the axios interceptor redirects to `/login` on 401                                       |
| 403 with a role message                 | `authorize()` on the route — check the [role matrix](./04-api-reference.md#4-role-matrix)                                          |
| CORS error in the console               | Origin not in the allowlist in`index.js` — are you on port 80 instead of 5173?                                                    |
| `Validation failed` with `errors[]` | The Zod schema for that route; field paths are dotted (`items.0.quantity`)                                                         |
| 409 with a`field` key                 | Unique constraint — email, category name, customer phone, or`(medicineId, batchNumber)`                                           |
| Silent field loss on save               | The field is absent from the Zod schema and was stripped                                                                             |
| Prisma engine / openssl error           | Re-run`npx prisma generate` in the current environment                                                                             |
| Backend exits on start                  | Postgres unreachable —`config/db.js` calls `process.exit(1)` by design                                                          |
| Port already in use                     | `lsof -ti:5000 \| xargs kill -9`, or change the mapping in compose                                                                  |
| Frontend can't reach the API            | Check the Vite proxy target (`VITE_PROXY_TARGET`); env values are inlined at build time, so restart Vite after changing either var |

## 11. Git workflow

```bash
git switch -c feat/purchase-orders
# … work …
npm run lint          # frontend
git commit -m "purchases: add purchase controller and routes"
git push -u origin feat/purchase-orders
```

`main` is the default and PR target. Branch names: `feat/`, `fix/`, `docs/`, `chore/`.

Before opening a PR:

- [ ] `npm run lint` passes in `frontend/`
- [ ] `npm run build` passes in `frontend/` (catches type errors CI would otherwise miss)
- [ ] Schema changes ship with a migration
- [ ] New/changed endpoints are in [04 — API Reference](./04-api-reference.md)
- [ ] New capabilities have an `FR-` id in [01 — PRD](./01-product-requirements.md)
- [ ] No secret, `.env` file or credential is staged

## 12. Repository map

```
medical-billing/
├── docker-compose.yml        4 services (frontend, backend, postgres, nginx)
├── docker-compose.prod.yml   the deployable stack — no bind mounts, no literals
├── .env                      gitignored — JWT_SECRET lives here
├── .env.prod.example         copy to .env.prod and fill in every value
├── Architecture.txt          historical plan; superseded by docs/02
├── README.md                 what this is and how to run it; links into docs/
├── CHANGELOG.md              1.0.0, plus 1.1.0 unreleased on main
├── docs/                     ← this documentation set
├── scripts/                  backup.sh · restore.sh · gen-cert.sh
├── nginx/
│   ├── nginx.conf            dev: :80 → frontend:5173 and /api → backend:5000
│   └── nginx.prod.conf       prod: TLS, HSTS, CSP, 80 → 443
├── backend/
│   ├── prisma/schema.prisma  12 models, 6 enums, 8 migrations
│   ├── src/                  index (boot guard + listen) · app (createApp factory)
│   │                         · config · middlewares · validators · routes
│   │                         · controllers · utils
│   ├── tests/                604 tests; needs a DATABASE_URL ending in _test
│   ├── Dockerfile            multi-stage production image, runs as USER node
│   ├── Dockerfile.dev        node:22-slim + openssl + nodemon
│   └── .env                  gitignored
└── frontend/
    ├── src/                  pages · components/ui · store · hooks · lib · types
    ├── e2e/                  Playwright browser smoke, 6 flows
    ├── vite.config.ts        React 19 compiler, Tailwind v4, @ alias, /api proxy
    ├── Dockerfile            builds with Vite, serves from nginx:alpine
    ├── Dockerfile.dev        node:22-slim, npm install --legacy-peer-deps
    └── .env                  gitignored (empty — the SPA needs no variables)
```

---

## Running in production

The development stack (`docker-compose.yml`) mounts the source, runs nodemon and the Vite dev server, and speaks plain HTTP. It is not a deployment. `docker-compose.prod.yml` is.

```bash
./scripts/gen-cert.sh                     # or drop a real certificate into certs/
cp .env.prod.example .env.prod            # then fill in every value
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npx prisma migrate deploy
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run seed
```

Then open `https://localhost`. The seeded admin can sign in and do exactly one thing: replace its password. Every other route answers `403 PASSWORD_CHANGE_REQUIRED` until it does.

|             | Development                | Production                               |
| ----------- | -------------------------- | ---------------------------------------- |
| Source      | Bind-mounted, hot reloaded | Baked into the image                     |
| Frontend    | Vite dev server on 5173    | Static files from`nginx:alpine`        |
| Backend     | `nodemon`                | `node src/index.js` as a non-root user |
| Transport   | HTTP on 80                 | HTTPS on 443, HTTP redirects             |
| Postgres    | Published on 5432          | Internal network only                    |
| Credentials | Literals in compose        | Required environment variables           |
| Logs        | Pretty, human-readable     | One JSON object per line                 |

### Health

`/health` is liveness — is the process up? It is deliberately cheap and touches nothing, so a database outage cannot cause an orchestrator to kill an otherwise healthy process and turn an incident into a restart loop.

`/health/ready` is readiness — can it actually serve? It runs `SELECT 1` and returns **503** with the reason when the database is unreachable. That is what a load balancer needs in order to route around an instance.

It also names the build answering:

```json
{ "success": true, "message": "…", "timestamp": "…", "version": "2.0.0", "commit": "3904fcd" }
```

`commit` comes from `RENDER_GIT_COMMIT` (set by the platform) or `GIT_COMMIT` anywhere else, and reads `unknown` in development where the question does not arise.

**Why it is there.** On 2026-09-01 four features were live in the browser and missing from the API: the frontend host had redeployed on push and the API host had not. Every symptom was a `404`, which is indistinguishable from a route nobody wrote — `GET /api/medicines/units` answered `{"message":"Medicine not found"}`, because the request fell through to `/:id`. Establishing that production was merely *behind* took probing an unrelated public endpoint and arguing from its absence. One `curl /health` answers it now:

```bash
curl -s https://<api-host>/health | jq -r .commit   # against `git rev-parse --short HEAD`
```

### Customer retention

Customer details are erased after 36 months without a purchase; invoices are untouched and keep 8 years as books of account ([03 §8](./03-data-model.md#8-data-lifecycle--retention)).

```bash
# What would be erased — changes nothing.
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run purge:customers

# Actually erase.
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run purge:customers -- --apply
```

**Nothing runs it for you.** There is no background worker in this stack by design, so schedule it — a nightly entry in the host's crontab is enough:

```cron
15 2 * * *  cd /srv/medical-billing && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend npm run purge:customers -- --apply >> /var/log/medbill-retention.log 2>&1
```

Override the window with `CUSTOMER_RETENTION_MONTHS` if the shop's policy differs. The dry run is the default precisely because a purge cannot be undone.

### Audit-log retention

The audit log keeps **24 months** and is then purged (NFR-17, [03 §3.12](./03-data-model.md#312-auditlog--who-changed-what)). Same shape as the customer sweep, same reason: the software supplies the tool, you schedule it.

```bash
# What would be deleted, and how old the oldest row is — changes nothing.
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run purge:audit

# Actually delete.
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend npm run purge:audit -- --apply
```

```cron
45 2 * * *  cd /srv/medical-billing && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend npm run purge:audit -- --apply >> /var/log/medbill-retention.log 2>&1
```

Half an hour after the customer sweep rather than alongside it, so that if one fails the log says plainly which. Override the window with `AUDIT_RETENTION_MONTHS`.

**These two sweeps are independent, and deliberately so.** Both touch a customer's audit rows — erasure redacts their payloads, this deletes them by age — but neither needs the other to have run. Deleting a row is stronger than redacting one, and an erasure whose audit history has already aged out still completes cleanly. Run them in either order, or one without the other.

### Backups

```bash
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.prod ./scripts/backup.sh
COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.prod ./scripts/restore.sh backups/<file>.dump
```

`backup.sh` writes a compressed custom-format dump into `backups/` and prunes anything older than `RETAIN_DAYS` (30 by default). It reads the credentials from the running container rather than duplicating them, so it cannot drift out of step with the stack it backs up.

**Rehearse the restore, on a schedule.** A backup you have never restored is a hope. The procedure above was rehearsed on 2026-08-20 by dropping the entire `public` schema from the running production stack, restoring from a dump, and confirming every row count matched and the application authenticated again.

`restore.sh` asks for confirmation before replacing a database, and runs inside a single transaction so a failure rolls back rather than leaving something that is neither the old state nor the new. Set `FORCE=1` for unattended use.

### Rotating the database password

Postgres applies `POSTGRES_USER` and `POSTGRES_PASSWORD` **only when it initialises an empty data directory**. Changing them in `.env.prod` on a running system does nothing to the database, and the API then fails to authenticate with `P1000`. Either:

```sql
ALTER ROLE myuser WITH PASSWORD 'the new one';
```

then update `.env.prod` and restart the backend — or take a dump, recreate the volume, and restore into it.
