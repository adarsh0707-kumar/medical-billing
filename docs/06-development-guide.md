# 06 — Development Guide

Everything needed to go from a clean checkout to a running, editable system.

---

## 1. Prerequisites

| Tool                | Version | Needed for                                                 |
| ------------------- | ------- | ---------------------------------------------------------- |
| Docker + Compose v2 | current | The recommended path                                       |
| Node.js             | 20.x    | Local (non-Docker) runs — both images use`node:20-slim` |
| npm                 | 10.x    |                                                            |
| PostgreSQL          | 15      | Only if running without Docker                             |
| Redis               | 7       | Optional — the API runs fine without it                   |

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
> The root README's claim that the frontend runs on port 3000 is wrong — compose maps 5173.

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
# Postgres and Redis must already be running locally.

cd backend
npm install
cat > .env <<'EOF'
DATABASE_URL="postgresql://medadmin:medpass123@localhost:5432/medicaldb"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="<32+ random bytes>"
PORT=5000
NODE_ENV=development
FRONTEND_URL="http://localhost:5173"
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

`frontend/.env` sets `PORT` and `FRONTEND_URL` but not `VITE_API_URL`, which is what you want: the client calls `/api` relative to its own origin and the dev server proxies it to `http://localhost:5000`. Set `VITE_PROXY_TARGET` if the API is elsewhere, or `VITE_API_URL` if it is on another host entirely — then restart Vite, since env values are inlined at build time.

## 4. Environment variables

### Backend

| Variable         | Required | Default                    | Purpose                                                                 |
| ---------------- | :------: | -------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` |    ✅    | —                         | Postgres connection string. Process exits if unreachable                |
| `JWT_SECRET`   |    ✅    | —                         | HMAC key for tokens.**No fallback** — signing throws without it  |
| `REDIS_URL`    |          | `redis://localhost:6379` | Client connects; nothing reads it yet                                   |
| `PORT`         |          | `5000`                   |                                                                         |
| `NODE_ENV`     |          | —                         | `development` enables Prisma query logs and error stacks in responses |
| `FRONTEND_URL` |          | —                         | Appended to the CORS allowlist when set                                 |
| `TRUST_PROXY`  |          | `loopback, linklocal, uniquelocal` | Express `trust proxy` value — which peers may set `X-Forwarded-For`, and therefore what the rate limiter keys on |

CORS allows, always: `http://localhost:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://172.17.0.1:5173`, plus `FRONTEND_URL`. Requests with **no** Origin header (curl, Postman, server-to-server) are allowed.

### Frontend

| Variable         | Required | Default                   | Purpose                             |
| ---------------- | :------: | ------------------------- | ----------------------------------- |
| `VITE_API_URL`     |          | *(empty — relative `/api`)* | Only for an API on another host. Inlined at build time |
| `VITE_PROXY_TARGET` |          | `http://localhost:5000`    | Where the **dev server** forwards `/api` (compose sets `http://backend:5000`) |

### Root

| Variable       | Used by                | Purpose                                 |
| -------------- | ---------------------- | --------------------------------------- |
| `JWT_SECRET` | `docker-compose.yml` | Interpolated into the backend container |

All `.env` files are gitignored. Never commit one.

## 5. Command reference

### Backend (`cd backend`)

| Command                     | Effect                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run dev`             | nodemon on`src/index.js`                                                                                  |
| `npm start`               | plain node                                                                                                  |
| `npm run seed`            | Upsert the admin user                                                                                       |
| `npm run prisma:generate` | Regenerate the Prisma client (after any schema edit)                                                        |
| `npm run prisma:migrate`  | `prisma migrate dev` — author and apply a migration                                                      |
| `npm run prisma:studio`   | Database browser on :5555                                                                                   |
| `npm test`                | Run the suite. **Requires a `DATABASE_URL` whose database name ends in `_test`** — the harness refuses anything else, because it wipes tables between tests |
| `npm run test:watch`      | Same, in watch mode |
| `npm run test:coverage`   | With a coverage report and the 90% gate on the invoice and auth paths |

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

Worked example: `GET /api/inventory/medicines/:id/batches`.

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
const res = await api.get(`/api/inventory/medicines/${id}/batches`);
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

| Symptom                                 | Where to look                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 401 on every request                    | Token missing/expired in`localStorage`; the axios interceptor redirects to `/login` on 401 |
| 403 with a role message                 | `authorize()` on the route — check the [role matrix](./04-api-reference.md#4-role-matrix)    |
| CORS error in the console               | Origin not in the allowlist in`index.js` — are you on port 80 instead of 5173?              |
| `Validation failed` with `errors[]` | The Zod schema for that route; field paths are dotted (`items.0.quantity`)                   |
| 409 with a`field` key                 | Unique constraint — email, category name, customer phone, or`(medicineId, batchNumber)`     |
| Silent field loss on save               | The field is absent from the Zod schema and was stripped                                       |
| Prisma engine / openssl error           | Re-run`npx prisma generate` in the current environment                                       |
| Backend exits on start                  | Postgres unreachable —`config/db.js` calls `process.exit(1)` by design                    |
| `⚠️ Redis connection failed`        | Non-fatal and expected when Redis is down; nothing depends on it                               |
| Port already in use                     | `lsof -ti:5000 \| xargs kill -9`, or change the mapping in compose                            |
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
├── docker-compose.yml        5 services; JWT_SECRET from host env
├── .env                      gitignored — JWT_SECRET lives here
├── Architecture.txt          historical plan; superseded by docs/02
├── README.md                 partly aspirational — see docs/08
├── CHANGELOG.md              v1.0.0 release notes
├── docs/                     ← this documentation set
├── nginx/nginx.conf          :80 → frontend:5173 and /api → backend:5000
├── backend/
│   ├── prisma/schema.prisma  11 models, 4 enums, 5 migrations
│   ├── src/                  index · config · middlewares · validators · routes
│   │                         · controllers · utils
│   ├── Dockerfile.dev        node:20-slim + openssl + nodemon
│   └── .env                  gitignored
└── frontend/
    ├── src/                  pages · components/ui · store · hooks · lib · types
    ├── vite.config.ts        React 19 compiler, Tailwind v4, @ alias
    ├── Dockerfile.dev        node:20-slim, npm install --legacy-peer-deps
    └── .env                  gitignored
```
